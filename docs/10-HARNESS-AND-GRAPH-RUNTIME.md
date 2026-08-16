# 10 — Harness and Graph Runtime

Status: DRAFT for adversarial review. Written from `research/DESIGN-SPINE.md` (binding) under
the claim-labeling discipline of `research/METHODOLOGY.md`. Everything not carrying an explicit
evidence label is OUR PROPOSAL. Covers mission Phases 11 (planner architecture), 13 (loop
runtime), 14 (graph runtime), 15 (harness contract). Sibling docs referenced by number are
being written concurrently from the same spine.

Vocabulary is spine §2 and is load-bearing throughout: a **harness** is a behaviour contract,
never "the runtime"; an **agent** is a configuration, never a type; a **graph/workflow** is a
declarative orchestration strategy artifact, never an engine; the **agent loop** is the
reactive strategy inside one harness turn cycle; the **planner** is a capability that emits
Plan artifacts.

---

## 1. The harness is a behaviour contract

### 1.1 The two poles of evidence

The industry has produced two extreme answers to "what is a harness, architecturally," and
they bound the design space.

**Pole A — harness as pure composition (Microsoft Agent Framework).**

- Evidence — SOURCE-CODE OBSERVATION (HIGH): MAF's `create_harness_agent()` assembles a
  Claude-Code-class harness entirely from existing extension slots: `AgentLoopMiddleware`
  (multi-pass loop with pluggable termination — todo predicates, background-task checks, an
  LLM judge returning a structured `JudgeVerdict`), `TodoProvider`, `AgentModeProvider`,
  `FileMemoryProvider`, `BackgroundAgentsProvider` (subagents as tools), and
  `ToolApprovalMiddleware` with a function-invocation budget. No new runtime concept was
  introduced; the harness is middleware plus context providers around an unchanged
  function-calling loop (research/notes/microsoft-autogen-sk-agent-framework.md).
- Interpretation — A Claude-Code-shaped harness requires zero kernel primitives beyond good
  interception and injection slots. "Harness" is provably a library-level composition.
- Implication — The harness must not be a kernel object. What the kernel must supply is the
  substrate the composition hangs on: interception points, an injection pipeline with
  provenance, budgets, and a journaled loop.
- Confidence — HIGH.

**Pole B — harness as opaque product (Claude Code).**

- Evidence — FACT + SOURCE-CODE OBSERVATION (HIGH): Anthropic's own docs name Claude Code
  "the agentic harness around Claude"; the Claude Agent SDK is a thin supervisor that spawns
  a closed-source CLI binary over NDJSON stdio — the loop, compaction prompts, and system
  prompt assembly are unobservable; the SDK contributes only the host-process surface (hooks,
  `canUseTool`, message stream) (research/notes/anthropic-claude-code-agent-sdk.md).
- Interpretation — A harness can be a sealed, versioned, invocable unit of value delivered
  behind a supervisor API. The cost is total loss of loop observability, policy interposition
  from outside is limited to sanctioned hook points, and the harness is welded to one model
  family.
- Implication — Kyxo adopts the *packaging* lesson of Pole B (a harness is a shippable,
  versioned, invocable artifact) and the *construction* lesson of Pole A (it is built from
  callbacks over a generic substrate, not a monolith), and rejects the opacity: the loop's
  interior is journal-visible by construction (§3.4).
- Confidence — HIGH.

Between the poles sits corroborating convergence: LangChain's own taxonomy separates
runtime (LangGraph) from harness (Deep Agents, Claude Agent SDK) as distinct layers (FACT,
research/notes/langgraph.md), and all eight competitive coding agents implement the harness
as a separable layer over swappable models (SOURCE-CODE OBSERVATION/HIGH,
research/notes/coding-agents-landscape.md).

### 1.2 The OTP-shaped split

OUR PROPOSAL. Kyxo structures the harness the way OTP structures `gen_server`: a generic,
battle-hardened driver owns the mechanics every loop needs; the specific behaviour supplies
callbacks. The split of responsibilities:

**Kernel/stdlib owns (generic loop mechanics — identical for every harness):**

| Mechanic | What it does | Evidence anchor |
|---|---|---|
| Event intake | Delivers user input, tool observations, external events, suspension resolutions into the cell as journal-ordered events | Codex SQ/EQ; ADK event loop (both notes) |
| Checkpoint-at-yield | Every callback return is a yield-is-commit point: effects in the returned decision are journaled atomically before the behaviour resumes | ADK's one contract that survived the 1.x→2.x rewrite intact (research/notes/google-adk.md, SOURCE-CODE OBSERVATION/HIGH) |
| Budget charging | Grant decrement at commit, tree-wide; refusal-to-spawn and child-stop on exhaustion | Claude Code `maxBudgetUsd` tree enforcement pattern, retrofitted there, native here (research/notes/anthropic-claude-code-agent-sdk.md) |
| Cancellation | Propagated between callbacks at commit points; a behaviour never needs cancellation logic | Codex `Op::Interrupt`; LangGraph `request_drain()` |
| Typed suspension | `approval-required` / `input-required` / `auth-required` invocation states with typed payloads, persisted in checkpoints | MAF request-info ports stored inside checkpoints; OpenAI `NextStepInterruption` + RunState (both notes) |
| Loop accounting | Iteration counters, progress hashes, failure streaks — computed by the driver, handed to policy (§3) | Gemini CLI LoopDetectionService; Roo mistake counters (research/notes/coding-agents-landscape.md) |

**The harness supplies (callbacks — the judgment):** context compilation, action choice,
observation integration, continuation judgment, verification, recovery.

### 1.3 The callback interface

OUR PROPOSAL — the V1 TypeScript behaviour contract. Types referenced from doc
05-KERNEL-PRIMITIVES (kernel objects) and doc 06-CAPABILITY-SPEC (manifests, negotiation).

```typescript
/**
 * Everything a harness callback may touch. Kernel verbs are pre-bound to the
 * cell's Grant; there is no ambient authority. The behaviour cannot reach
 * around this surface: every effect is an Invocation, every persisted fact a
 * journal Event, every payload an Artifact reference.
 */
interface HarnessCtx {
  readonly cell: CellRef;                       // single-writer scope this run occupies
  readonly objective: ArtifactRef<Objective>;   // the Kind instance being pursued
  readonly grant: GrantView;                    // rights + remaining budgets (read-only)
  readonly bindings: BindingSet;                // sealed negotiation results, incl. the
                                                // model adapter binding and its
                                                // model-behavior profile (§2.4)
  readonly journal: JournalView;                // typed read/query over this cell's events
  readonly policy: LoopPolicyView;              // the declarative controls of §3.2

  /** The only effect verb. Async-first; returns a handle whose lifecycle is the
   *  kernel invocation state machine. Identity is deterministic (§5.2). */
  invoke(req: InvocationRequest): InvocationHandle;

  /** Append a typed harness event to the journal (charged, ordered, committed). */
  emit(evt: HarnessEvent): void;

  /** Block on an external decision (human, guardian capability, parent cell).
   *  Checkpoints underneath; survives process death. */
  suspend<T>(s: TypedSuspension<T>): Promise<T>;
}

/** A harness is a behaviour module implementing this contract. It ships with a
 *  capability manifest and is registered, negotiated, invoked, versioned, and
 *  benchmarked exactly like any other capability (§1.4). */
interface HarnessBehaviour<S> {
  readonly manifest: CapabilityManifest;        // axes: task classes, model-profile
                                                // requirements, tool-surface shape,
                                                // termination policies supported

  /** Establish initial behaviour state from the objective. Pure of effects. */
  init(ctx: HarnessCtx): Promise<S>;

  /** Deterministically compile the per-invocation view: instructions, memory
   *  cells, retrieved artifacts, tool schemas — under the token budget, with
   *  provenance labels surviving into the view (doc 09). */
  compileContext(ctx: HarnessCtx, state: S): Promise<CompiledContext>;

  /** One decision step: typically a model-adapter invocation followed by zero
   *  or more capability invocations. Returns intents, not raw effects — the
   *  driver journals and executes them. */
  act(ctx: HarnessCtx, state: S, view: CompiledContext): Promise<ActResult>;

  /** Fold one observation (tool result, verifier finding, child-cell result,
   *  suspension resolution) into behaviour state. */
  integrateObservation(ctx: HarnessCtx, state: S, obs: Observation): Promise<S>;

  /** Judgment: what happens next. The driver calls this after observations are
   *  integrated AND whenever a loop-policy signal fires; `signals` carries the
   *  driver's accounting (iteration count, progress hash delta, failure streak,
   *  budget fraction remaining, deadline proximity). */
  decideContinuation(
    ctx: HarnessCtx, state: S, signals: LoopSignals
  ): Promise<ContinuationDecision>;

  /** Optional: produce Evidence artifacts for a candidate outcome. Runs before
   *  the commit gate (doc 08); the gate itself is kernel policy, not harness. */
  verify?(ctx: HarnessCtx, state: S, candidate: ArtifactRef): Promise<EvidenceRef[]>;

  /** Optional: map a failure record to a recovery decision. Absent, the cell's
   *  supervision policy applies directly (doc 13). */
  recover?(ctx: HarnessCtx, state: S, failure: FailureRecord): Promise<RecoveryDecision>;
}

/** Closed decision union — the control-flow vocabulary of every strategy. */
type ContinuationDecision =
  | { kind: "continue" }                                  // next iteration
  | { kind: "finalize"; output: ArtifactRef }             // subject to verify + commit gate
  | { kind: "delegate"; req: InvocationRequest;           // child cell under attenuated grant
      attenuation: AttenuationSpec }
  | { kind: "suspend"; suspension: TypedSuspension<unknown> }
  | { kind: "switch-strategy"; harness: CapabilityRequirement;  // §7 composition
      carry: ArtifactRef[] }
  | { kind: "escalate"; to: EscalationTarget; reason: string }  // model ladder or human
  | { kind: "rollback"; to: CheckpointRef }
  | { kind: "fail"; error: FailureRecord };
```

- Evidence — SOURCE-CODE OBSERVATION (HIGH): OpenAI's runner resolves every turn into a
  closed four-way union (`NextStepFinalOutput | NextStepHandoff | NextStepRunAgain |
  NextStepInterruption`); its note concludes the union is the real control-flow contract while
  the detection heuristics are hard-coded (research/notes/openai-agents-sdk-codex.md).
- Interpretation — The union is right; the hard-coding is the mistake. Kyxo keeps a closed
  decision vocabulary (so the driver, checkpoints, and journal projections stay total over
  it) and moves the *judgment that selects among decisions* into the behaviour callback plus
  declarative policy, extending the union with the observed variants OpenAI lacks
  (strategy switch, rollback, model escalation).
- Implication — Every orchestration strategy in this document — reactive loop, graph runner,
  generated-code runner, supervisor — implements this same interface. Composition (§7)
  follows from that uniformity, not from special mechanisms.
- Confidence — HIGH.

### 1.4 Harnesses are capabilities

OUR PROPOSAL, mandated by spine §2/§3. A `HarnessBehaviour` ships with a versioned manifest
and enters the same registry as tools and model adapters. Consequences, each doing real work:

1. **Invocable.** `runtime.run({objective})` resolves the default profile's harness by
   negotiation like any capability; a graph node can require a harness (§5); a harness can
   delegate to a different harness under an attenuated Grant.
2. **Versioned.** Harness identity is `name@semver + behaviour-hash`; events pin it
   (version-by-data, spine §7), so a journal entry always names exactly which harness logic
   produced it, and fork-from-checkpoint across harness versions is a first-class repair verb.
3. **Benchmarkable.** Because harness and model adapter are both manifest-bearing
   capabilities, `model × harness` matrices are a mechanical enumeration (§2.3) — the spine §9
   DX requirement.
4. **Negotiable.** A harness manifest declares which model-behavior profile axes it requires
   (e.g. "needs reasoning-trace carry-through", "needs parallel-tool-call safety"); binding a
   harness to a model adapter that lacks a required axis fails loudly at bind time (spine §4),
   instead of silently degrading in production.

```mermaid
flowchart TB
  subgraph CELL["Cell (single-writer, journaled)"]
    direction TB
    DRV["Generic loop driver (stdlib)\nevent intake · checkpoint-at-yield · budget charge\ncancellation · typed suspension · loop accounting"]
    HB["HarnessBehaviour callbacks (capability)\ncompileContext → act → integrateObservation\n→ decideContinuation → verify / recover"]
    DRV -- "callbacks with HarnessCtx" --> HB
    HB -- "ContinuationDecision" --> DRV
  end
  DRV -- "Invocations (deterministic identity)" --> K["Kernel: Binding · Grant · Policy pipeline"]
  DRV -- "Events (truth plane)" --> J[("Journal + Checkpoints")]
  K --> CAPS["Capabilities: model adapters · tools ·\nverifiers · child harnesses · humans"]
```

---

## 2. The mission's harness questions, answered

### 2.1 Is the harness kernel-first-class? No.

Apply the spine §3 admission rule: a concept enters the kernel only if competing userland
implementations would prevent required functionality (security, accounting, recovery,
coordination). The harness fails the test decisively — competing userland implementations not
only could exist, they *dominate the evidence*: MAF's harness is middleware
(SOURCE-CODE OBSERVATION/HIGH), Deep Agents is a package over LangGraph (FACT), ADK's
`App`+`Runner` harness sits over a node/event substrate it does not own (SOURCE-CODE
OBSERVATION/HIGH), and eight coding agents each built their own without any shared runtime
(SOURCE-CODE OBSERVATION/HIGH). Security, accounting, recovery, and coordination are all
supplied *to* the harness by Grants, budgets, checkpoints, and cells — none is supplied *by*
it. The harness is a behaviour/strategy: spine §3's explicit non-primitive list stands.

What IS kernel-adjacent is the driver (§1.2): the generic loop mechanics live in the stdlib
against kernel objects, because checkpoint-at-yield and budget-charge-at-commit must be
uniform across all harnesses or the accounting and recovery guarantees fracture. The line:
mechanics below the callback interface, judgment above it.

### 2.2 Do different harnesses run the same model? Yes — and pairs are the unit.

- Evidence — FACT (HIGH): GPT-5.1-Codex-Max runs under at least two production harnesses with
  materially different skins: OpenAI's shell-oriented Codex harness, and Cursor's harness
  after weeks of adaptation — tools renamed to shell-like equivalents matching the model's RL
  training distribution, reasoning traces preserved across turns (dropping them cost ~30%
  performance), message ordering rearranged (research/notes/cursor.md). FACT: Claude models
  run under Claude Code, MAF, Cursor, Aider, and OpenCode harnesses simultaneously.
  SOURCE-CODE OBSERVATION (HIGH): Aider binds edit format per model in its model catalog;
  Copilot's `EditToolLearningService` measures per-model edit-tool success and adapts the
  exposed toolset at runtime (research/notes/coding-agents-landscape.md). FACT: Cursor
  trained Composer *inside* the production harness with a shadow backend so tools behaved
  identically to production (research/notes/cursor.md).
- Interpretation — Spine C2, confirmed from three independent directions: harness quality is
  partially model coupling. The same logical harness carries per-model dialects; the same
  model behaves differently under different harnesses; and the frontier of integration is
  models trained into a specific harness. There is no universal harness, and there is no
  model-agnostic harness of competitive quality.
- Implication — Kyxo's unit of deployment, versioning, and measurement is the
  **harness×model pair**: `(harness@version, model-adapter@version, profile-overrides)` — a
  registered artifact with its own outcome-telemetry stream. The kernel and record format
  stay model-independent; pairs are model-specific, first-class, and unashamed (spine C2).
- Confidence — HIGH.

### 2.3 The benchmark design: matrix runs over one objective corpus

OUR PROPOSAL (executes the spine §9 requirement; scoped in detail by doc 37). The design
falls out of §1.4 with almost no new machinery:

1. **Enumeration.** Both factors are capabilities with manifests. The benchmark runner (itself
   an orchestration strategy in a cell) enumerates `harness × model-adapter` pairs, discarding
   pairs whose bind-time negotiation fails (a required profile axis missing). Declarations
   gate *eligibility* (spine C3) — an ineligible pair is a recorded fact, not a zero score.
2. **Corpus.** A versioned corpus of Objective artifacts (a Kind), each carrying acceptance
   criteria as required Evidence types (tests pass, artifact schema-valid, judge rubric ≥
   threshold). The corpus is content-addressed; a benchmark result cites corpus version,
   pair versions, and policy hash, or it is not comparable.
3. **Matrix runs.** Each cell of the matrix = one Objective run under an identical Grant
   slice (same token/money/wall-clock budget, same loop policy, same tool capability set).
   The one sanctioned per-pair variation is the model-behavior profile (§2.4): prompt
   patches, dialect choices, trace-carry settings. Rationale: Cursor's evidence shows
   un-adapted harnesses understate a model by large margins (FACT — the ~30% reasoning-trace
   figure), so "identical prompts" would measure adaptation debt, not capability. The profile
   applied is pinned in the run record.
4. **Paired metrics from the journal.** Every metric is a projection of the truth plane — no
   separate instrumentation. The Phase-37 metric set, all derivable from kernel objects:
   verified success rate (Evidence gates passed), cost-per-success (Grant decrements: tokens,
   USD), wall-clock and invocation latency distributions, iterations to termination,
   termination cause histogram (§3.3), stagnation and repeated-failure events, escalations
   (model-ladder and human), recovery success after injected faults (doc 13's scenario set),
   delegation depth/width, compiled-context sizes, and plan-mutation counts for graph
   strategies (§5.4).
5. **Telemetry feedback.** Results write into the pair's capability record as outcome
   telemetry. Routing consumes it: telemetry drives *selection* among eligible pairs (spine
   C3). This closes the loop that Copilot's EditToolLearningService implements locally
   (SOURCE-CODE OBSERVATION/HIGH) — Kyxo makes the same measure-and-adapt cycle a substrate
   feature spanning all capabilities, not one hard-coded edit-tool service.

### 2.4 Model-behavior profiles live in the adapter manifest

- Evidence — FACT (HIGH): Anthropic documents that "Claude Opus 5 delegates to subagents more
  readily than earlier models," and Claude Code's system prompt carries a model-conditional
  line suppressing Agent-tool use on Opus 5 — the harness patches its prompt per model
  version to compensate for behavioral drift. FACT: loop termination in Claude Code is
  "response contains no tool calls," i.e. completion judgment lives in the model and the
  harness merely detects it; per-model tool-use system prompts differ in token count per
  model (research/notes/anthropic-claude-code-agent-sdk.md). SOURCE-CODE OBSERVATION (HIGH):
  Cline anchors termination on an explicit `submit_and_exit` tool call instead — a per-model
  choice about whether termination judgment can be trusted to silence
  (research/notes/coding-agents-landscape.md).
- Interpretation — Termination judgment, delegation eagerness, edit-dialect competence,
  reasoning-trace requirements, and effort semantics are *model-behavioral* facts that every
  serious harness ends up encoding somewhere — today as scattered prompt hacks and
  hard-coded conditionals inside closed loops.
- Implication — Kyxo reifies them as the **model-behavior profile**: a section of the model
  adapter's axis-typed manifest (doc 06), versioned per model release, consumed by harnesses
  at bind time. V1 fields: `termination` (silence-is-done | completion-tool-required |
  judge-recommended), `delegationBias` (with per-version patches), `reasoningCarry`
  (required | beneficial | unsupported — with opaque carry-through artifacts per spine §2),
  `editDialects` (ranked, telemetry-updated), `toolNamingStyle` (e.g. shell-like), `parallelToolSafety`, `promptPatches`
  (keyed by model version, provenance-labeled), `effortSemantics`. Declared values are the
  adapter author's claims; probe results and outcome telemetry overlay them (spine C3's three
  information sources).
- Confidence — HIGH on the need; MEDIUM on the exact V1 field set (the axes are extracted
  from four independent systems, but no prior art validates this particular schema).

---

## 3. The loop runtime

### 3.1 One skeleton, many policies

- Evidence — SOURCE-CODE OBSERVATION (HIGH): across eight coding agents, the loop skeleton is
  identical (compile context → model → execute tools → integrate → repeat) and the *entire
  divergence* is continuation/termination policy: Gemini CLI's LLM next-speaker check and
  repetition-detecting LoopDetectionService; Copilot's autopilot caps (`MAX_AUTOPILOT_ITERATIONS
  = 5`); Roo's consecutive-mistake budget surfacing a human ask; Cline's completion-tool
  contract; Aider's `max_reflections = 3` (research/notes/coding-agents-landscape.md).
  SOURCE-CODE OBSERVATION (HIGH): MAF's `AgentLoopMiddleware` makes the same point from the
  framework side — termination predicates are pluggable values (`todos_remaining`,
  `background_tasks_running`, LLM judge) around one loop
  (research/notes/microsoft-autogen-sk-agent-framework.md).
- Interpretation — The loop is commodity; the controls are the product surface. Hard-coding
  any single termination heuristic (as OpenAI hard-codes no-pending-tools) forecloses the
  space every production system actually explores.
- Implication — Kyxo ships one generic bounded loop in the stdlib — the driver of §1.2
  running an observe/orient/act/verify skeleton (`integrateObservation` /` compileContext` /
  `act` / `verify`) — and expresses **every control as declarative policy** attached to the
  cell, evaluated by the driver, with decisions delegated to `decideContinuation`.
- Confidence — HIGH.

### 3.2 All controls as declarative policy

OUR PROPOSAL — the `LoopPolicy` schema (a Kind; validated, versioned, hash-pinned per run):

```typescript
interface LoopPolicy {
  maxIterations?: number;              // hard cap on turn cycles
  budget?: BudgetSliceSpec;            // attenuated slice of the cell's Grant:
                                       // tokens, USD, invocations, spawn depth/width
  deadline?: DurationSpec;             // wall-clock; driver-enforced (absent in Claude
                                       // Code — a documented gap we close)
  stagnation?: {
    progressHash: ProgressHashSpec;    // what counts as progress: hash over declared
                                       // state cells + artifact versions + open todo set
    window: number;                    // unchanged hash for N iterations => signal
    action: PolicyAction;
  };
  repeatedFailure?: {
    maxConsecutive: number;            // Roo-style mistake budget
    matcher?: FailureClassSpec;        // which failure classes count
    action: PolicyAction;
  };
  escalationLadder?: {                 // model escalation as data
    rungs: CapabilityRequirement[];    // e.g. fast model -> frontier model
    triggers: EscalationTrigger[];     // stagnation | repeated-failure | verify-failed
    maxRungs: number;
  };
  termination: TerminationPolicy[];    // ordered; first verdict wins (§3.3)
  onExhaustion: PolicyAction;          // what happens when caps hit
}

type PolicyAction =
  | { kind: "signal-behaviour" }       // surface in LoopSignals; behaviour decides
  | { kind: "switch-strategy"; harness: CapabilityRequirement }
  | { kind: "rollback"; to: "last-verified-checkpoint" | CheckpointRef }
  | { kind: "escalate-model" }         // next rung of the ladder
  | { kind: "escalate-human"; suspension: TypedSuspension<HumanDecision> }
  | { kind: "finalize-partial" }       // emit best candidate + Evidence of incompleteness
  | { kind: "fail" };
```

Notes on the two novel members. **Stagnation via progress-hash**: the nearest prior art is
Gemini CLI's chunk-level repetition detector and Claude Code's compaction-thrashing detector
(both SOURCE-CODE OBSERVATION/FACT) — output-similarity heuristics. Kyxo instead hashes
*declared progress state* (state cells, artifact versions, todo set), which is cheap because
those are already journaled, and semantically honest: no new artifacts and no state movement
across N iterations *is* stagnation, whereas similar-looking text may not be. INFERENCE
(MEDIUM): this is a strict improvement, but it depends on strategies declaring their progress
cells; the default profile derives them from the harness manifest. **Escalation ladders**:
Cursor Router proves model selection is a per-request policy decision with billing
consequences (FACT, research/notes/cursor.md); Aider's architect/editor and Cursor's
`reapply`-escalates-to-a-smarter-model prove intra-task model switching works
(FACT/SOURCE-CODE OBSERVATION). Kyxo makes the ladder a declared sequence of capability
requirements resolved through ordinary negotiation, so an escalation is a new Binding — 
policy-visible, budget-charged, journaled.

### 3.3 Termination policies are pluggable values

Every observed variant becomes a `TerminationPolicy` provider — none is hard-coded:

| Policy | Verdict rule | Observed in (label) |
|---|---|---|
| `no-pending-tools` | model response with zero tool calls ⇒ done | Claude Code, OpenAI Agents SDK (FACT/SOURCE-CODE OBSERVATION) |
| `completion-tool` | explicit `finish`-class tool call required | Cline `submit_and_exit`, ADK task-mode `finish_task` (SOURCE-CODE OBSERVATION) |
| `next-speaker-check` | cheap structured side-model call adjudicates continue/stop | Gemini CLI (SOURCE-CODE OBSERVATION) |
| `judge-verdict` | second model returns structured done/more verdict | MAF `with_judge` (SOURCE-CODE OBSERVATION) |
| `todos-remaining` | open items in a plan/todo state cell ⇒ continue | MAF, Roo (SOURCE-CODE OBSERVATION) |
| `mistake-budget` | consecutive-failure count exceeds cap ⇒ stop/escalate | Roo (SOURCE-CODE OBSERVATION) |
| `evidence-satisfied` | objective's required Evidence artifacts all present and gate-passed | none — OUR PROPOSAL, enabled by the doc-08 commit gate |

The last row is the differentiated one: because verification is a kernel hook (spine §5),
"done" can be defined as *verified done*, which no studied system can express in its loop
(ADK's note records verification-absent-from-the-loop explicitly; INFERENCE/HIGH).

### 3.4 Loops are observable via the journal — never hidden

OUR PROPOSAL, enforced by construction: the driver emits typed events for every phase —
`loop.iteration-started`, `loop.context-compiled` (with source provenance and token
accounting), `loop.acted` (invocation refs), `loop.observation-integrated`,
`loop.continuation-decided` (the decision **and the signals that produced it**),
`loop.policy-triggered` (which rule, which threshold). Since callbacks can only act through
`HarnessCtx`, a harness *cannot* run an invisible inner loop: every model call and tool call
is an Invocation on the journal. This is the direct negation of the two opaque poles — Claude
Code's closed binary and Cursor's server-side loop (FACT: even Cursor's own hooks expose only
sanctioned taps; the loop interior is unobservable) — and it is what makes §2.3's metrics
projections and doc 13's supervision possible. Live observation streams remain the advisory
plane with weaker guarantees (spine §2); the journal is the truth.

---

## 4. Planner architecture (Phase 11)

### 4.1 The planner component is dead; planning as data is alive

- Evidence — FACT (HIGH): SK's Stepwise/Handlebars planners were deprecated in 2024 in favor
  of function calling; MAF ships no planner concept at all
  (research/notes/microsoft-autogen-sk-agent-framework.md). SOURCE-CODE OBSERVATION (HIGH):
  ADK's `BasePlanner` is a two-method prompt shim (thinking-config passthrough or ReAct tag
  format) — not an orchestrator (research/notes/google-adk.md). SOURCE-CODE OBSERVATION
  (HIGH): across eight coding agents, a dedicated planner component is ABSENT everywhere;
  "plan mode" is uniformly the same loop under a read-only policy profile; but plans-as-
  artifacts thrive: Roo's mandated `update_todo_list` and checklist-carrying `new_task`,
  Copilot cloud's surfaced implementation-plan stage, Cursor's editable Plan-Mode plan with
  structured to-dos, Codex's `plan_tool` (research/notes/coding-agents-landscape.md,
  research/notes/cursor.md, research/notes/openai-agents-sdk-codex.md).
- Interpretation — What died is the planner as a privileged runtime component that *owns
  control flow*. What survived, in every system, is (a) planning as model reasoning and (b)
  the plan as an inspectable, editable data artifact that other things consume.
- Implication — In Kyxo a **planner is any capability that emits Plan artifacts** (spine §2).
  It holds no control flow, no special runtime position, no authority. Strategies consume
  plans; the kernel stores and versions them.
- Confidence — HIGH.

### 4.2 The Plan Kind

OUR PROPOSAL. `Plan` is a registered Kind (spine §3, object 9): schema-validated, versioned
with one storage version + conversion, watchable.

```typescript
interface Plan {
  kind: "kyxo.dev/Plan@v1";
  objective: ArtifactRef<Objective>;
  version: number;                       // monotonic; mutations create new versions (§5.4)
  provenance: PlanProvenance;            // producing invocation (which planner, which
                                         // model), inputs, trigger for this version
  steps: PlanStep[];
  dependencies: Array<[stepId, stepId]>; // partial order; parallelism is its absence
  assumptions?: EvidenceRef[];           // what this plan believes; invalidation
                                         // of an assumption is a mutation trigger
}

interface PlanStep {
  id: string;
  intent: string;                        // human/model-readable purpose
  requires: CapabilityRequirement;       // an expression over manifests — NEVER a
                                         // binding, NEVER an endpoint, NEVER code
  inputs: InputMapping;                  // state cells / artifacts consumed
  acceptance: EvidenceRequirement[];     // what Evidence must exist to call it done
  budgetHint?: BudgetEstimate;           // advisory; the Grant is not the plan's to give
}
```

**Plan = data, never code with authority.** Three enforcement rules: a Plan carries no Grant
and cannot be granted to; a `PlanStep.requires` is resolved to a Binding only by the
*executing strategy* at execution time, through ordinary negotiation under the executing
cell's Grant; and a Plan is inert — nothing in the kernel executes a Plan, only strategies
that read one. This is the structural answer to plan-injection: a poisoned or hallucinated
plan can propose anything and authorize nothing, because authority flows exclusively through
the Grant lineage (spine §3, object 7). Contrast the generated-code frontend (§6), which IS
code — and therefore runs sandboxed under an attenuated grant, precisely because it crosses
this line deliberately.

### 4.3 Planner families as interchangeable providers

All expose the same capability profile (`planner`: Objective + context in → Plan artifact
out), differing only in manifest axes and telemetry:

| Family | Mechanism | Prior-art anchor | Cost profile |
|---|---|---|---|
| Reactive | no upfront plan; the agent loop plans-as-it-goes, optionally maintaining a todo state cell as a degenerate rolling Plan | every coding agent's default mode (SOURCE-CODE OBSERVATION/HIGH) | zero upfront, opaque lookahead |
| Hierarchical | decompose objective → sub-objectives recursively; emits nested Plans; sub-plans producible lazily | Roo orchestrator prompt pattern; Magentic-One orchestrator-as-library (SOURCE-CODE OBSERVATION) | medium; bounded by decomposition depth |
| LLM single-shot | one strong-model call drafts the full Plan; cheap to re-run on mutation triggers | Cursor Plan Mode, Copilot cloud plan phase (FACT) | one frontier call per version |
| Symbolic/constraint | deterministic solver over typed step libraries (build graphs, migration orderings); no model call | no direct agent-stack prior art — classical planning imported; flagged as such (INFERENCE/MEDIUM that demand exists, e.g. release/migration pipelines) | cheap, complete, narrow domain |
| Cost-aware | wraps any of the above; optimizes step assignment over capability outcome telemetry and remaining budget (which pair for which step class) | Cursor Router's cost/quality routing modes (FACT) generalized | adds a scoring pass |

Because planners are capabilities, they are benchmarkable with the §2.3 matrix (planner ×
executor-strategy × model), and selectable by routing telemetry like everything else.

---

## 5. The graph runtime is a strategy (Phase 14)

### 5.1 Why the graph is a frontend: the channels evidence

- Evidence — SOURCE-CODE OBSERVATION (HIGH): In LangGraph, edges do not exist at runtime.
  `StateGraph.compile()` lowers nodes and edges onto channels (`branch:to:X` ephemeral
  channels for edges, `NamedBarrierValue` channels for joins, reducer channels for state
  keys); task planning is version-vector diffing (`versions_seen` vs `channel_versions`),
  "no runtime edge data structure at all"; the functional API compiles to the identical
  substrate (research/notes/langgraph.md). Convergently: MAF runs typed executors in Pregel
  supersteps with checkpoint-at-barrier (SOURCE-CODE OBSERVATION/HIGH); ADK 2.0's `Workflow`
  is itself a node whose loop-state is *not persisted* — reconstructed from the same event
  log as everything else (SOURCE-CODE OBSERVATION/HIGH). And zero of eight coding agents
  contain a graph engine (SOURCE-CODE OBSERVATION/HIGH,
  research/notes/coding-agents-landscape.md).
- Interpretation — The strongest graph runtimes in the industry do not run graphs; they run
  a state/step/checkpoint substrate and compile the graph notation onto it. The graph is an
  authoring and verification surface. Meanwhile the systems that skipped graphs entirely lost
  nothing they needed.
- Implication — Kyxo's graph runtime is a userland strategy: a `HarnessBehaviour` (§1.3)
  that reads a Graph artifact and compiles it to kernel invocations in a cell. No graph
  concept enters the kernel (spine §3 non-primitives). The kernel contributes exactly what
  the convergent substrates contribute: journaled effects, checkpoint-at-yield, dynamic
  invocation spawn with deterministic identity, budget charging, typed suspension.
- Confidence — HIGH.

### 5.2 The graph artifact schema and compile-to-invocations

OUR PROPOSAL. `Graph` is a Kind, typically compiled from a Plan (and back-referencing it):

```typescript
interface Graph {
  kind: "kyxo.dev/Graph@v1";
  planRef?: ArtifactRef<Plan>;           // provenance chain: Objective -> Plan -> Graph
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  joins: JoinSpec[];
  defaults: { retry?: RetrySpec; timeout?: DurationSpec };
}

interface GraphNode {
  id: string;
  requires: CapabilityRequirement;       // requirement expression — resolved to a
                                         // Binding per occurrence at execution time;
                                         // a node may require a harness (§7)
  input: InputMapping;                   // reads from state cells / artifacts
  output: OutputBinding;                 // writes to state cells (via reducers)
  attenuation: AttenuationSpec;          // grant slice for this node's invocations
  retry?: RetrySpec; timeout?: DurationSpec;
}

interface GraphEdge {
  from: string; to: string;
  when?: ConditionExpr;                  // declarative predicate over the source
                                         // node's emitted events / route values /
                                         // state-cell reads — data, not callbacks
}

interface JoinSpec {
  id: string;
  over: StateCellRef;                    // joins are properties of state, not scheduler
  reducer: ReducerRef;                   // registered reducer capability or builtin
                                         // (append, merge, last-value, custom)
  barrier: { awaiting: string[] }        // named writers that must have written
         | { count: number }             // or a dynamic-fan-in count
         | { predicate: ConditionExpr };
}
```

Design decisions and their evidence:

- **Nodes are capability requirement expressions, not hardcoded bindings.** The graph says
  *what kind of worker* each step needs; negotiation at execution time chooses the provider
  under current telemetry and budget. This is what makes one graph artifact portable across
  harness×model pairs and what makes the §2.3 matrix runnable over graph strategies. The
  anti-pattern is MAF's serialized edges installing "loud-failing proxies" when a named
  callable is missing after deserialization (SOURCE-CODE OBSERVATION) — identity-by-code-
  reference breaks portability; identity-by-requirement survives it.
- **Joins as state-cell reducers/barriers.** LangGraph proves joins are correctly a property
  of state, not of the scheduler: multi-input edges compile to `NamedBarrierValue` channels,
  and reducers attached to channels are what make parallel fan-in deterministic
  (SOURCE-CODE OBSERVATION/HIGH). Kyxo adopts this: a join is a reducer + barrier condition
  on a Kind-typed state cell; the graph runner merely watches for barrier satisfaction. Write
  ordering into reducers is deterministic (sorted by invocation identity), copying
  LangGraph's sort-by-task-path rule.
- **Compile-to-invocations with deterministic identity.** Each ready node occurrence becomes
  an Invocation with identity `uuid5(cellId, graphArtifactHash, version, nodeId,
  occurrenceIndex, dynamicPath)`. Evidence this is the linchpin: LangGraph derives task IDs
  `uuid5/xxhash over (checkpoint_id, ns, step, node, path)` and hangs resume, memoization,
  and error-handler routing off them; MAF validates checkpoint compatibility with a
  `graph_signature_hash` (both SOURCE-CODE OBSERVATION/HIGH). Deterministic identity is what
  lets a resumed or mutated graph *not* re-execute completed side effects — the kernel's
  memoized-resume contract (spine §5 "dynamic dispatch," doc 08).
- **Dynamic fan-out is native, not an escape hatch.** LangGraph accreted `Send`, `Command`,
  and mid-step `accept_push` as backdoors from static topology; ADK added `ctx.run_node`
  (both SOURCE-CODE OBSERVATION/HIGH; both notes conclude "dynamic dispatch always wins").
  Kyxo starts there: a node's invocation may spawn further invocations with derived identity
  (`dynamicPath` extends the tuple); the static topology is the *verifiable skeleton*, not a
  cage. Doc 04 carries the strategy-level analysis.

### 5.3 Execution model

The graph runner behaviour maps onto §1.3 directly: `compileContext` = evaluate ready set
(edges whose conditions hold, barriers satisfied) against the journal; `act` = negotiate
bindings and emit invocations for ready nodes (parallel branches = concurrent pending
invocations in the cell; the kernel scheduler owns actual concurrency and leases);
`integrateObservation` = fold node completions into state cells through reducers;
`decideContinuation` = `continue` while nodes are pending/ready, `finalize` when terminal
outputs exist, `suspend` when a node's invocation enters `approval-required`/`input-required`
(MAF's request-info-port pattern generalized — the suspension is typed and checkpointed),
policy actions per §3.2 otherwise. Loop policy applies to graph runs unchanged: a graph cell
has iteration caps (supersteps), budget, deadline, stagnation detection over its state cells.

**Persistence and recovery need nothing graph-specific.** A Checkpoint (spine §3, object 8)
of the graph cell — journal position + state snapshot + pending invocations, bound to the
graph artifact hash — is complete recovery state. Evidence this suffices: ADK's graph engine
keeps *no private persistence*, reconstructing node status entirely from the shared event log
(SOURCE-CODE OBSERVATION/HIGH); MAF's checkpoint (in-flight messages + state + pending
requests + signature hash) is definition-scoped and rehydrates in a fresh process
(SOURCE-CODE OBSERVATION/HIGH); LangGraph's entire commercial control plane is stateless
workers over the checkpoint contract (FACT). Kyxo inherits that property by construction:
the graph runner is a client of the journal like every other strategy.

### 5.4 Mutation as new plan/graph versions

OUR PROPOSAL. The pipeline is `Objective → Plan (planner capability) → Graph (compiler
capability) → execution (graph-runner strategy)`, and it is a *loop*, not a line:

```mermaid
flowchart LR
  O[Objective] --> P["Plan vN\n(planner capability)"]
  P --> G["Graph vN\n(compile)"]
  G --> X["Graph-runner cell\ninvocations · reducers · joins"]
  X -- "Evidence artifacts" --> V{"commit gates\n(doc 08)"}
  V -- "verification failure" --> M
  X -- "new evidence arrives" --> M
  X -- "budget pressure signal" --> M
  M["Mutation request\n(typed, journaled)"] --> P2["Plan vN+1\n(planner re-invoked\nwith trigger + journal view)"]
  P2 --> G2["Graph vN+1"]
  G2 -- "rebase: identity-stable nodes continue,\nremoved cancelled, new scheduled" --> X
```

Mutation triggers, each a typed journal event: **verification failure** (a node's Evidence
fails its acceptance requirement — the gate rejects promotion and the graph must route around
or retry differently), **evidence arrival** (new information invalidates a Plan assumption —
`Plan.assumptions` exists precisely to make this checkable), **budget pressure** (Grant
depletion crosses a declared threshold; the cost-aware planner can re-plan onto cheaper
pairs or prune optional branches). The mutation itself is: re-invoke a planner capability
with the trigger and the current journal view; it emits Plan vN+1; compilation emits Graph
vN+1; the runner **rebases** — invocations whose deterministic identity is unchanged between
versions continue untouched (their identity tuple contains nodeId + inputs-hash, not graph
version, for exactly this reason); removed nodes are cancelled through normal cancellation;
new nodes schedule normally.

**Provenance of mutations** is non-optional: `PlanProvenance` on each version records the
triggering event, the planner invocation that produced the version, and the diff — so the
journal answers "why did the plan change, who changed it, what did it believe at the time."
No studied system versions its plans at all (the closest are Cursor's human-editable plan and
Roo's mutable todo list, both un-provenanced — FACT/SOURCE-CODE OBSERVATION); this is
genuine differentiation enabled by Kinds + Artifacts, not repackaging. INFERENCE (MEDIUM):
plan mutation mid-flight is the least production-validated mechanism in this document; the
rebase rules need prototype validation (task 4) and a doc-08 treatment of
mutation-during-pending-join.

### 5.5 Nested and recursive graphs under grant attenuation

A `GraphNode.requires` may resolve to a capability that is itself an orchestrator — another
graph strategy, a loop harness, a remote runtime. The child runs in its own cell under an
attenuated Grant (child ≤ parent: rights and quantitative budget, including spawn
depth/width — spine §3, object 7), making recursion structurally bounded: a graph that
spawns graphs exhausts spawn-depth budget, not the operator's patience. Parent interposition
on child suspensions follows MAF's proven pattern — a parent executor can intercept a
sub-workflow's request-info messages and answer or escalate (SOURCE-CODE OBSERVATION/HIGH) —
generalized here as: a child cell's typed suspensions surface to the parent cell first, which
may resolve, transform, or propagate them. Delegation is thus the ordinary invocation
mechanism (spine §2 "delegation system"), not a graph feature.

---

## 6. Generated-code orchestration: the third frontend

- Evidence — FACT (HIGH): Claude Code's dynamic workflows are JavaScript scripts, written by
  the model, executed by a runtime *outside the conversation* against exactly two primitives
  (`agent(prompt, {schema})`, `pipeline(list, fn)`); "the script holds the loop, the
  branching, and the intermediate results itself, so Claude's context holds only the final
  answer"; scripts are saveable and re-runnable as commands; runs are resumable with
  completed-agent results replayed from cache; the sandbox forbids user input, filesystem,
  shell, and `import()` (research/notes/anthropic-claude-code-agent-sdk.md). Convergent:
  OpenAI's `ProgrammaticToolCallingTool` runs model-emitted JS in a hosted V8 with only
  opted-in tools callable (FACT); MAF ships CodeAct in Hyperlight WASM micro-VMs and the
  Monty interpreter, with registered tools callable from inside the sandbox but not exposed
  as direct agent tools (SOURCE-CODE OBSERVATION/HIGH). Three vendors, independently, in one
  year.
- Interpretation — Once a delegation primitive with schema-validated outputs exists,
  orchestration-as-generated-imperative-code displaces graph DSLs for model-authored
  coordination: the model is better at writing programs than at emitting graph JSON, the
  script keeps intermediate state out of the context window, and repeatability comes from
  persisting the program. The Claude Code note states the kernel lesson directly: "a kernel
  needs a deterministic script sandbox with only kernel-API bindings, not a graph engine."
- Implication — Kyxo treats generated code as the **third orchestration frontend**, peer to
  the loop and the graph, with the same substrate underneath.
- Confidence — HIGH.

OUR PROPOSAL — the mechanism:

1. **The script runner is a strategy** (a `HarnessBehaviour` hosting a sandboxed interpreter
   — WASM component or isolate per doc 07's isolation waves). The sandbox's *only* imports
   are kernel verbs pre-bound to the cell's Grant: `invoke`, state-cell read, `emit`,
   `suspend`. No filesystem, no network, no ambient anything: the script's blast radius is
   exactly its Grant, which is the structural difference from every "the model wrote code,
   run it" design — and the reason generated code may hold authority where a Plan (§4.2) may
   not: its authority is a kernel-attenuated Grant, not self-asserted.
2. **The script is a repeatability artifact**: content-addressed, provenance-carrying
   (which invocation generated it, from which objective), promotable through verification
   gates like any artifact, and re-invocable as a capability with a manifest derived from its
   declared inputs/outputs. This makes Claude Code's "save the workflow as a command" a
   substrate feature: one-off orchestration hardens into a named, versioned, benchmarkable
   capability with zero translation.
3. **Effects get deterministic identity** derived from `(script hash, call-site index,
   iteration counters, args hash)`, so resume replays completed invocations from the journal
   instead of re-executing them — the same memoized-resume contract as graph nodes (§5.2).
   Claude Code's order-dependent replay cache is the precedent and the warning: order-keyed
   caching is fragile under nondeterministic script control flow (INFERENCE/HIGH), which is
   why Kyxo keys on call-site + args, not sequence position.
4. **Budget and depth are the loop policy's** (§3.2) — Claude Code's ≤16 concurrent / ≤1000
   agents / stagger rules (FACT) become ordinary declarative caps on the script cell's Grant
   slice rather than magic numbers in a runtime.

---

## 7. Choosing and composing strategies

### 7.1 Strategy-choice guidance

OUR PROPOSAL (synthesizing the whole evidence base; problem-class rows are judgment, the
per-row anchors are labeled in the cited notes):

| Problem class | Strategy | Why (anchor) |
|---|---|---|
| Open-ended, under-specified objective (debug this, research that) | Reactive loop harness | The universally converged default; planning-in-model beats upfront structure when the structure is unknowable (all eight coding agents) |
| Multi-step with known dependency structure, meaningful parallelism, human gates | Graph strategy from a Plan | Static skeleton is verifiable/auditable before spend; joins and typed suspensions are native (MAF/LangGraph substrate evidence) |
| High-volume homogeneous fan-out (per-file, per-record, map-reduce) | Generated-code frontend; or graph dynamic spawn | Script keeps N intermediate results out of context (Claude Code workflows); dynamic identity makes resume cheap |
| Deterministic, repeatable pipeline (release, migration, ETL-like) | Persisted generated-code artifact or declarative graph; symbolic planner upstream | Repeatability = persisted program/graph + journal; no model call needed at plan time |
| Verification-heavy work (high-stakes edits, compliance) | Loop harness + out-of-loop Evidence gates; `evidence-satisfied` termination | Two-altitude verification (spine §5); Copilot cloud's platform-gate pattern |
| Exploration/retrieval as a sub-task | Delegated subagent loop under tight budget slice | Convergent across five systems: session + policy diff + budget + single result (coding-agents landscape); SWE-grep/Cline research agents |
| Multi-perspective deliberation (review boards, debate) | Group-chat/supervisor strategy (userland library) | Demoted-to-library everywhere (MAF orchestrations; langgraph-supervisor unmaintained) — supported, never privileged |
| Long-horizon supervised automation (routines, PR stewarding) | Trigger → fresh cell running any of the above | Triggers are delivery, not orchestration (Copilot automations, Cursor automations, ambient agents) |

Default profile (spine §9, C4): `runtime.run({objective})` gets the reactive loop harness
with standard tools, the default LoopPolicy, and `no-pending-tools` + `evidence-satisfied`
termination. Everything above is opt-in configuration of the same objects.

### 7.2 Composition rules

Composition needs no mechanism beyond what §§1–6 established; it needs *rules*, all
consequences of "strategies are capabilities running in cells under Grants":

1. **A graph node can host a loop harness.** `GraphNode.requires` names a harness
   capability; the occurrence becomes a child cell running that behaviour under the node's
   attenuation. This is how "mostly-structured pipeline with one open-ended step" is
   expressed — the shape MAF reaches via `AgentExecutor`-wraps-agent-in-graph
   (SOURCE-CODE OBSERVATION/HIGH), here with budget and policy attenuation the wrapping
   lacks.
2. **A loop can spawn a graph.** A loop harness invokes a planner, gets a Plan, and issues
   `delegate` to a graph-runner capability with the compiled Graph — the child graph cell
   runs under an attenuated slice, and its single result returns as an observation. Plan
   mode grows teeth: instead of "same loop, read-only tools" (the industry's plan mode,
   SOURCE-CODE OBSERVATION/HIGH), the plan becomes an executable, verifiable artifact.
3. **Generated code composes with both**: a script's `invoke` may target a harness or a
   graph runner; a graph node or loop may require the script-runner capability with a
   persisted script artifact.
4. **All composition is mediated by Invocation + Grant attenuation.** No strategy ever calls
   another in-process; there is no shared mutable state between strategies except declared
   state cells with reducers. Cross-strategy visibility is journal projection, never
   ambient.
5. **Recursion is bounded structurally**: spawn depth/width are quantitative Grant rights
   decremented per delegation; exhaustion produces the typed `budget-exceeded` suspension —
   escalation, not overflow (spine §3, object 7; the enforcement contract Claude Code
   documents as refuse-spawn/stop-children/typed-error, made uniform).
6. **`switch-strategy` is a first-class continuation** (§1.3): a stagnating loop can hand
   its objective and carried artifacts to a plan-execute strategy (or vice versa) inside the
   same cell lineage, journaled as an ordinary decision with its triggering signals.

### 7.3 What this document commits us to

The costs, stated plainly. (1) Six callbacks and a closed decision union are a *stronger*
contract than any studied system imposes on its harness layer; porting an existing harness
(e.g. wrapping the Claude Agent SDK's supervisor surface as a Kyxo harness capability) means
mapping an opaque loop onto our phases, and Pole-B harnesses will fit only coarsely (the
whole closed binary becomes one `act`). We accept coarse wrapping for foreign harnesses;
native harnesses get the full benefit. (2) Declarative loop policy trades expressiveness for
auditability; genuinely novel controls must extend the PolicyAction vocabulary through Kind
versioning rather than ad-hoc code. (3) Three frontends (loop, graph, generated code) over
one substrate is more surface than one blessed frontend; the LangGraph two-frontend
precedent (SOURCE-CODE OBSERVATION: graph + functional API over identical kernel constructs,
full fidelity) is our evidence the substrate, not the frontend count, is the load-bearing
design — but doc 37's benchmarks must confirm the frontends don't diverge semantically under
faults. (4) Model-behavior profiles put vendor-specific behavioral claims into manifests;
keeping them honest requires the probe + telemetry overlay to actually ship (doc 06), or the
profiles rot into folklore.
