# Design Spine

Status: **DECIDED (pre-adversarial-review)** — this is the single coordination document from
which all `docs/` deliverables are written. Every decision cites its evidence base in
`research/notes/`. The adversarial review (Phase: challenge) may amend it; amendments are
logged at the bottom. Labels follow `research/METHODOLOGY.md`. Everything in this file that is
not explicitly labeled otherwise is OUR PROPOSAL.

Project name: **Kyxo**. The minimal core is the **Kyxo kernel**; the whole system (kernel +
standard capabilities + SDKs) is the **Kyxo runtime**.

---

## 1. Verdict on the hypotheses

**H1 (kernel hypothesis) — CONFIRMED, with the strongest evidence class available: independent
convergent evolution.** Four unrelated teams arrived at the same shape under production
pressure:

- Google ADK 2.0 abandoned "everything is an agent" for nodes-emitting-events over a
  yield-is-commit runner, deprecating its own SequentialAgent/ParallelAgent/LoopAgent one
  major version after shipping them (`google-adk.md`, SOURCE-CODE OBSERVATION/HIGH).
- Microsoft collapsed AutoGen + Semantic Kernel into MAF: typed executors + Pregel supersteps
  + checkpoint-at-barrier + typed request ports + one discriminated event stream; group chat,
  planners, and even a Claude-Code-class harness became libraries over that substrate
  (`microsoft-autogen-sk-agent-framework.md`).
- LangGraph's kernel is not a graph: channels + BSP super-steps + checkpoints; the graph API
  and the Temporal-shaped functional API are two frontends compiled onto the same substrate;
  edges do not exist at runtime (`langgraph.md`).
- Claude Code reduces to model call + tool call + typed vetoable event + append-only
  transcript; subagents, skills, workflows and checkpoints are compositions
  (`anthropic-claude-code-agent-sdk.md`).

Zero of eight competitive coding agents contain a graph/DAG engine; "plan mode" is uniformly a
policy profile over the same loop; delegation converged on `session + capability/policy diff +
budget + single result message` (`coding-agents-landscape.md`). The planner as a component is
dead across Microsoft's stack and absent everywhere else. Conclusion: loop, graph, workflow,
planner, supervisor, swarm are **orchestration strategies**; none is kernel material.

**H2 (capability hypothesis) — CONFIRMED with a critical amendment.** PydanticAI v2 ships
first-class attachable "capabilities"; OpenAI's beta sandbox-agents package introduces
`Capabilities.default()`; Codex grew `capabilities.rs`/`permissions.rs`; MCP's capability
grammar survived a full protocol rewrite; A2A proves total executor opacity is
standardizable. The amendment: **a capability contract must carry per-model/per-consumer
dialects and empirical outcome telemetry, not only static declarations** — Aider's per-model
edit formats, Copilot's EditToolLearningService, and Cursor's tool-renaming-for-Codex prove
the same logical capability needs different skins per model, with runtime feedback
(`coding-agents-landscape.md`, `cursor.md`).

**H3 (determinism split) — CONFIRMED.** All three durable-execution systems impose the
identical invariant (deterministic orchestration, journaled nondeterministic effects); Temporal
wrapping the unmodified OpenAI SDK proves the split can be enforced without touching reasoning
(`durable-execution.md`, `openai-agents-sdk-codex.md`).

**H4 (negotiation over identity) — CONFIRMED as direction, REFINED in mechanism.** Boolean
feature flags are inadequate: model interaction paradigms diverge on ~16 independent axes with
tiers (reasoning visibility/replay/budget-control alone has 5 incompatible paradigms;
stripping unknown fields is correct on one provider and a hard 400 on another)
(`open-model-infrastructure.md`). Negotiation must be axis-typed, tiered, two-sided,
must-ignore-unknown, greased, and supplemented by probing and telemetry.

**H5 (event-sourced truth) — CONFIRMED, journal-first not replay-first.** Append-only logs are
the working source of truth in ADK, Claude Code, Codex (rollout JSONL), and Restate. But
Temporal-style positional-replay determinism taxes AI code whose prompts change weekly; the
correct model is record-and-inject journaling with first-class checkpoints (snapshot + journal
position + pending effects) and a two-tier store (references in the log, payloads in
content-addressed storage) (`durable-execution.md`, `langgraph.md`).

**Counter-hypotheses adjudicated:**

- **C1 (the layer already exists piecemeal)** — Partially true and priced in. MCP + A2A +
  LangGraph/MAF + Temporal cover tools, federation, orchestration state, durability. But the
  gap map is consistent across ALL notes: nobody owns budgets-as-resource-lineage,
  verification at the commit point, capability negotiation for models, delegation attenuation,
  cross-boundary provenance, or a portable execution record format. Those are exactly the
  kernel's product surface (see §6). MCP's maintainers say so explicitly: agent lifecycle,
  budgets, checkpoints, policy are declared out of scope (`mcp-protocol.md`).
- **C2 (harness quality IS model coupling)** — TRUE, and it reshapes the thesis. Cursor spends
  weeks adapting its harness per model, renamed tools to match a model's RL training
  distribution, lost ~30% performance when dropping reasoning traces, and trained Composer
  inside the production harness (`cursor.md`, FACT/HIGH). Therefore Kyxo does **not** promise
  a universal harness. It promises a universal **substrate** beneath swappable, versioned,
  benchmarkable harness×model pairs. Model-independence lives in the kernel and the record
  format; model-specificity lives in adapters and harnesses, first-class and unashamed.
- **C3 (declared capability ≠ competence)** — TRUE. The contract therefore has three
  information sources: declared manifest (what I claim), probe results (what you verified),
  outcome telemetry (what actually worked, per capability×model pair). Routing consumes all
  three. Declarations gate *eligibility*; telemetry drives *selection*.
- **C4 (the simple case won't stay simple)** — the standing risk; addressed by profiles
  (§9) and enforced by the DX requirement that `runtime.run(objective)` works with defaults.

## 2. Precise vocabulary (used everywhere; never interchangeable)

- **Model** — weights + inference procedure. Lives behind an API; never appears in the kernel.
- **Model API** — a wire protocol to inference (Messages, Responses, OpenAI-compat dialects,
  Realtime/Live sessions). Divergent by design; never normalized to an LCD.
- **Model adapter** — a *code-bearing* plugin (encode context→wire, decode wire→typed events)
  with an axis-typed manifest and opaque carry-through artifacts for provider state (reasoning
  items, signatures). Not a config record (`open-model-infrastructure.md`).
- **Agent** — a *configuration*, not a type: harness + bound capability set + grants + a cell
  to run in. The word never appears in kernel code.
- **Agent loop** — the reactive strategy inside one harness turn cycle.
- **Agent SDK** — a vendor's packaged harness + supervisor API (e.g. Claude Agent SDK is a
  thin supervisor over a closed harness binary).
- **Harness** — an orchestration strategy that turns a model into a competent worker: context
  compilation, tool exposure, loop policy, termination policy, recovery. In Kyxo a harness is
  a **behaviour contract** (OTP-style): the kernel/stdlib owns the generic loop mechanics
  (event intake, checkpointing, budget charging, cancellation); the harness supplies
  callbacks. Harnesses are themselves capabilities (invocable, versioned, benchmarkable).
- **Context-management system** — the deterministic *context compiler*: an ordered,
  inspectable processor pipeline that assembles the per-invocation view under a token budget
  (ADK's request-processor pipeline is the proven shape).
- **Memory system** — durable labeled state cells with provenance, quotas, and a compile hook;
  survives provider replacement (Letta's Block/compile design is the reference).
- **Tool runtime** — the standard capability providers for effectful primitives (shell, HTTP,
  files, MCP client) plus their sandboxes.
- **Execution environment** — a leasable capability (workspace, VM, container, browser) with
  declared build/snapshot lifecycle (Cursor environment.json is prior art).
- **Planner** — any capability that emits Plan artifacts. Not a kernel component.
- **Graph / Workflow** — a declarative orchestration strategy artifact, compiled to cell
  steps; versioned, mutable at runtime via new plan versions.
- **State machine** — the kernel's invocation lifecycle (closed transition algebra); also
  available as a userland strategy.
- **Task runtime** — kernel scheduling of invocations within cells.
- **Delegation system** — invocation of a capability that is itself an orchestrator, under an
  attenuated grant. Not a special mechanism.
- **Protocol** — external wire contracts (MCP, A2A, ACP, provider APIs). Adapters at edges;
  never the internal architecture.
- **Capability discovery** — enumerating manifests (registry + runtime advertisement events,
  Wayland-style).
- **Capability negotiation** — computing a Binding: intersecting requirements with a manifest,
  choosing dialects/tiers, sealing a typed feature set.
- **Policy/security layer** — object-capability authority (Grants) + ordered interposition
  pipeline + taint labels. Kernel mechanism, not middleware.
- **Durable execution** — journal + checkpoint + resume semantics owned by the kernel.
- **Event system** — the typed append-only journal (truth plane) + derived live observation
  streams (advisory plane, explicitly weaker guarantees).
- **Observability/tracing** — projections of the journal (OTel export); never a separate
  bolted-on event bus.
- **Application/product UX** — out of scope above the SDK; surfaces attach via the same event
  protocol (Codex App-Server pattern).

## 3. The kernel (apply Liedtke's minimality test to every entry)

Admission rule (FACT/HIGH from `prior-art-negotiation-extension.md`): *a concept is tolerated
inside the kernel only if permitting competing userland implementations would prevent required
functionality* — where required functionality = security, accounting, recovery, coordination.

**Nine kernel objects:**

1. **Capability** — unit of invocable function. Identity + versioned manifest. Everything
   northbound of the kernel and southbound of it is one: model adapters, tools, MCP servers,
   harnesses, graph strategies, verifiers, humans, environments, remote runtimes.
   *Passes the test*: a common invocable contract is the coordination substrate itself.
2. **Binding** — the sealed result of negotiation: capability + chosen dialect/tier set +
   grant + policy route. Bind-time is when two-sided declared feature sets intersect
   (LSP/MCP-shaped), unknown-must-ignore, unsolicited-use-is-error (TLS-shaped), GREASE
   injected from v0.
   *Passes*: policy and accounting attach here; userland bindings could forge authority.
3. **Invocation** — one use of a Binding. Async-first task lifecycle with a **closed
   transition algebra** extending A2A's states: `submitted → working → {input-required,
   auth-required, approval-required, budget-exceeded (interrupted class)} → … → {completed,
   failed, canceled, rejected} (terminal class)`. Carries idempotency key, correlation ID,
   causation ID, grant reference. Suspension payloads are typed (Mastra
   suspendSchema/resumeSchema pattern); `approval-required`/`budget-exceeded` generalize
   A2A's auth-required escalation chaining.
   *Passes*: exactly-once illusion, budget charging, and lineage must be kernel-enforced.
4. **Event** — typed, versioned, append-only journal record; two-tier (payloads by Artifact
   reference); correlation/causation/actor IDs; the truth plane. Live streams are projections
   with explicitly weaker guarantees (advisory plane).
   *Passes*: recovery and audit require kernel-owned truth; ADK's untyped widening envelope
   (Event extends a provider type) is the documented failure to avoid.
5. **Artifact** — content-addressed immutable payload + provenance (producing invocation,
   inputs, labels). Taint/integrity/confidentiality labels propagate structurally (FIDES
   productizes this; Claude Code's subagent-output scanning is the retrofit we replace).
   *Passes*: zero-copy reference passing across isolation boundaries is the Mach/L4 lesson —
   the crossing primitive must be near-zero-cost.
6. **Cell** — keyed, single-writer, stateful execution scope with activation-on-demand;
   sessions, agents, harness runs, graph executions live in cells. The Orleans grain /
   Restate Virtual Object / Temporal entity-workflow convergence (independently reinvented
   three times — INFERENCE/HIGH).
   *Passes*: single-writer consistency and lifecycle cannot be a userland convention.
7. **Grant** — unforgeable, attenuable, revocable authority reference carrying both rights
   (what) and quantitative budget (how much: tokens, money, wall-clock, invocations, spawn
   depth/width, risk class). Grants form a lineage tree; the kernel decrements at commit;
   attenuation-on-delegation is mandatory (child ≤ parent). Object-capability discipline:
   no ambient authority, interposition invisible to the holder.
   *Passes*: this is the definition of "the AI cannot grant itself privilege". Budgets as
   attenuated quantitative rights is our one genuinely novel kernel object (limited prior
   art; flagged as such).
8. **Checkpoint** — named consistent cut of a cell: journal position + state snapshot +
   pending invocations, bound to definition identity (strategy hash + lineage), portable
   across processes (MAF's definition-scoped checkpoints are the model; Cursor's `&` handoff
   proves state-transfer migration works commercially).
   *Passes*: only the journal owner can cut consistently.
9. **Kind** — registered userland type (CRD move): Objective, Plan, Evidence, Memory block,
   TestReport… The kernel provides storage, schema validation, multi-version serving with
   one storage version + conversion, watch streams; all semantics live in userland
   controllers/strategies.
   *Passes*: this is precisely how new concepts arrive without kernel changes — the
   future-proofing mechanism itself.

**Two kernel mechanisms (not objects):** the **policy pipeline** (ordered, declarative stages
evaluated at bind and at every effectful invocation; deny-class stages non-bypassable —
Claude Code's six-step pipeline is the proven shape) and the **scheduler** (cell turns,
leases, timeouts, cancellation propagation, deadline enforcement).

**Explicit non-primitives** (each fails the minimality test; all have competing userland
implementations in the evidence): Agent, Harness, Graph, Loop, Planner, Workflow, Prompt,
Message/Chat array, Tool (it's a capability profile), Memory tier policy, Model, Provider,
Supervisor, Swarm, Role/Team semantics, distributed transport (AutoGen's gRPC mesh was killed
in the MAF convergence — distribution belongs to protocol edges and portable checkpoints).

## 4. Capability contract (detail for 06)

Manifest grammar (three tiers, MCP-proven): typed named capability axes; an `experimental`
bag; governed reverse-DNS extensions with settings objects. Axes are typed with tiers, not
booleans — the 16-axis list from `open-model-infrastructure.md` (statefulness, prompt encoding
level, reasoning visibility/replay/budget, tool emission/result dialects, streaming grammar,
transport/session model, structured-output expressivity, caching contract, sampling surface,
modality/task types, resource lifecycle, discovery, error semantics, …) is the requirements
list for the model-facing axes; non-model capabilities use the same grammar with different
axes. Contract format: WIT-style typed worlds are the aspiration; V1 uses JSON-schema-typed
manifests with semver + date-versioned kernel protocol + stability classes
(experimental/testing/stable/deprecated, 12-month deprecation floor — MCP's lifecycle).

Invocation contract: request/response-with-streaming AND bidirectional session are both
first-class shapes (Realtime/Live cannot be lowered onto function calls — FACT/HIGH).
Non-chat task shapes (embed, rerank, classify, apply, transcribe) are first-class invocation
profiles, not chat impersonations.

Escape hatch (three layers, mandatory design): portable baseline axes → negotiated optional
tiers → **typed provider-native passthrough** (declared in the manifest, policy-visible,
provenance-labeled, never silently dropped; the `extra_body` pattern made honest). A binding
that requires an axis the target lacks **fails loudly at bind time**; the kernel never
silently degrades (silent-loss anti-pattern documented across providers).

Discovery: registry (static manifests, indexed without execution — VS Code pattern) +
runtime advertisement/removal events (Wayland global/global_remove) + `probe` invocations
(conformance/capability probes as first-class, cacheable evidence artifacts).

## 5. Orchestration, context, memory, verification (detail for 04/09/10/16)

- **Strategies as behaviours.** `ReactiveHarness`, `PlanExecuteHarness`, graph runner, loop
  runner, supervisor, swarm coordinator are userland behaviour modules run in cells. The
  kernel guarantees: journaled effects, checkpoint at yield-is-commit points (ADK's proven
  transactional primitive), budget charging, cancellation, typed suspension. Termination and
  continuation policies are pluggable (no-pending-tools, next-speaker check, mistake budgets,
  judge verdicts — all observed variants, none hard-coded).
- **Dynamic dispatch always wins** (LangGraph Send/Command, ADK ctx.run_node, generated-code
  workflows in Claude Code): the kernel natively supports dynamic invocation spawn with
  deterministic identity (uuid5-style derivation for memoized resume) — graphs are one
  frontend over that, generated imperative code is another.
- **Context ≠ Memory is a hard split.** Context: deterministic compile of a per-invocation
  view from sources (instructions, memory cells, retrieved artifacts, tool results) under
  budget, with provenance labels surviving into the compiled view; compaction is an event
  with pluggable executors (client-side, harness, or provider-side — Anthropic is migrating
  compaction into the API; the kernel must not hard-code client-side assumptions). Memory:
  labeled, quota'd, shareable state cells with confidence/decay/invalidation metadata;
  memory management is a reassignable principal (Letta sleep-time pattern).
- **Verification is a kernel hook, userland judgment.** The commit gate: policy stages may
  require Evidence artifacts before an invocation's outcome enters the truth plane or an
  artifact is promoted. Verifiers (tests, lint, typecheck, schema, judges, consensus, human
  review) are capabilities. Two attachment altitudes: in-loop observers feeding context;
  out-of-loop gates controlling promotion (Copilot's platform pattern). This hook is absent
  in every system studied — genuine differentiation, not repackaging (`google-adk.md`,
  `durable-execution.md`, `a2a-protocol.md` all record the absence).
- **Humans are capabilities with elicitation-shaped contracts** (form/URL split so secrets
  never transit the runtime; MCP's surviving client feature), typed suspensions, deadlines
  and escalation policies — plus non-negotiable responsibility metadata (who consented, who
  approved), never reduced to anonymous tools.
- **Providers are becoming runtimes** (Responses API state/hosted tools/background; server-
  side compaction): provider-side execution domains are modeled as remote cells with
  mirrored artifacts/budgets/policy, federated rather than proxied.

## 6. Positioning and differentiation (the gap map)

Kyxo is **an execution kernel and capability substrate beneath agent frameworks** — not a
framework, not a harness, not a protocol replacement. It speaks MCP southbound (tools), A2A
at the federation edge (remote agents), ACP-class protocols to surfaces, provider APIs via
adapters; internally it owns exactly what the ecosystem provably does not:

1. Grants: hierarchical budgets + authority with attenuation and lineage (absent everywhere;
   max_turns/max_llm_calls are the state of the art).
2. Verification at the commit point (absent in ADK, A2A, MCP, all durable engines).
3. Axis-typed capability negotiation with probes + telemetry (nothing negotiates today;
   `/v1/models` returns IDs).
4. Structural provenance/taint on artifacts and context (FIDES exists as middleware; nobody
   makes it an invariant).
5. Portable, published execution-record format (journal + checkpoint schema) — "durable
   execution has no MCP-equivalent" (`durable-execution.md`).
6. Delegation attenuation and recursion control as construction, not convention.

## 7. Failure semantics (detail for 08/13)

At-least-once + idempotency keys + dedup windows = exactly-once illusion (documented across
Restate/DBOS/Temporal). Leases with visibility timeouts for every external effect. Supervision
above the loop: OTP restart classes + restart intensity budgets extended to token/cost;
escalation to parent cells or humans. Version-by-data: config/prompt/model hashes pinned per
event; fork-from-checkpoint is the primary repair/upgrade verb; old code paths never required
to survive (anti-Temporal-patching decision). All 17 mission failure scenarios map to these
mechanisms (doc 08 carries the table).

## 8. Implementation decisions

- **V1 language: TypeScript reference kernel, protocol-first.** The kernel API is defined as
  a versioned schema (events, manifests, lifecycle) so the reference implementation is
  replaceable (Rust candidate post-validation) without breaking userland — the Codex
  SQ/EQ + App Server precedent, but versioned as a real spec from day one (their per-release
  drift is the documented failure mode). Python SDK follows; WASM component hosting is the
  extension path for sandboxed plugins. Rationale: DX speed for validation; single-node V1;
  the crossing primitive in-process is reference passing (zero-cost), deferring the
  isolation-cost question to the wave that introduces process/WASM isolation.
- **Single-node first.** Distribution = portable checkpoints + protocol edges (state-transfer
  migration, Cursor-style), never an in-kernel mesh (MAF killed theirs).
- **Storage V1**: SQLite/JSONL journal + file CAS; conformance-tested storage interface
  (LangGraph's checkpointer-conformance precedent).

## 9. DX contract

`runtime.run({ objective })` with defaults must work (default profile: one reactive harness,
standard tools, sane budgets/policies). Profiles bundle strategy + policy + budget choices.
Advanced surface is the same objects, explicit. The benchmark harness (doc 37-scope) can
express `model × harness` matrices because both are capabilities with manifests.

## 10. Recommendation (to be confirmed by adversarial review)

**BUILD WITH CHANGES** relative to the mission's implied scope: build the kernel + capability
substrate + record format; do NOT build a universal harness (host pairs instead); do NOT
invent new wire protocols (project onto MCP/A2A); single-node V1; ship the capability
manifest + probe suite for top targets as standalone early value. EXTEND was seriously
considered (LangGraph checkpoint kernel; MAF substrate) and rejected because Grants/ocap,
commit-gate verification, and the portable record format are structural — they cannot be
retrofitted into either without breaking their public contracts; both remain integration
targets as strategies/adapters instead.

---

## Amendment log

- (empty until adversarial review)
