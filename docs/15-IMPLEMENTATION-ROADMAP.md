# 15 — Implementation Roadmap

> **Post-review status (2026-08-16, phase 2).** This document predates the adversarial review; the
> review's binding adjudications live in the Amendment log of `research/DESIGN-SPINE.md` (A1–A14),
> with the full findings in `research/ADVERSARIAL-REVIEW.md`. They are now reflected in the body.
> **Applied here:** A1 (the executable property-test spec of journal/checkpoint/fork/dedup as a
> Wave-0 exit gate — **since built and passing**, §2 Wave 0, §4), A2 (reserve/settle/release,
> §2 Wave 1), A3 (guarantee grades frozen at Wave 0, graded at Wave 2; the waterline indicator on
> risk R5), A4 (the facade freeze joins the schema freeze in Wave 0), A5 (the governance workstream
> in Wave 0, with risk R11), A6 (the enforcement floor ships with the capability tier in Wave 2, not
> the hardening wave; risk R12), A7 (this document's wave numbering is canonical; **Wave 2's adapter
> roster corrected to doc 14's** — Anthropic Messages, OpenAI Responses, Gemini, one OpenAI-compat
> adapter carrying vLLM *and* Ollama manifests), A13 (selection contract and telemetry schema frozen
> at Wave 0, ranking in Wave 3), A14 (catalog scope: conformance-derived manifests for the four MVP
> adapters only; the community catalog is a governance deliverable — Wave 2, Wave 5, risk R6).
> **Outstanding:** none known.
> Where this document conflicts with the Amendment log, **the amendment log governs**.
>
> **Executable semantics supersede prose.** The Wave-0 semantic gate has been discharged ahead of
> schedule: `prototypes/kernel-semantics/` with normative prose in `docs/17-KERNEL-SEMANTICS.md`,
> checked invariants in `docs/18-KERNEL-INVARIANTS.md` and results in
> `docs/20-SEMANTIC-TEST-RESULTS.md`. Two risks in §4 are retired by that evidence and the residual
> risks that survive it are stated explicitly rather than left implied.


Status: DECIDED (pre-adversarial-review). Covers mission Phases 30 (waves), 31 (deployment
architecture), 35 (build-vs-reuse), 38 (self-hosting note). Written from
`research/DESIGN-SPINE.md`; vocabulary per spine §2 and `docs/05-KERNEL-PRIMITIVES.md`.
Everything here is OUR PROPOSAL unless carrying an explicit evidence label; evidence claims
cite the research notes.

Inherited implementation decisions this roadmap does not relitigate (spine §8): TypeScript
reference kernel, protocol-first (the kernel API is a versioned schema, the implementation is
replaceable); single-node V1; SQLite/JSONL journal + file CAS behind a conformance-tested
storage interface. The roadmap's job is to sequence that build so that (a) every wave ends in
something independently valuable, (b) the contracts freeze before the code that would ossify
them, and (c) the risks with kill-signals are instrumented from the wave in which they can
first fire.

---

## 1. Build vs. reuse (Phase 35)

The selection rule mirrors the kernel admission rule: **reuse everything that is not the
product surface.** The gap map (spine §6) says Kyxo's differentiation is grants/budgets,
commit-gate verification, axis-typed negotiation, structural provenance, the portable
execution-record format, and delegation attenuation. Every component on that list is BUILD.
Everything else — protocol plumbing, OAuth, tracing, sandbox primitives, model wire clients —
is ADOPT, WRAP, INTEGRATE, or DEFER. Building any of those would burn the schedule on
undifferentiated machinery and, worse, put us in maintenance competition with ecosystems
(MCP Tier-1 SDKs, OTel, OS sandboxes) that have full-time staff.

| Component | Decision | Reason | Risk |
|---|---|---|---|
| MCP protocol library | **ADOPT** the official TypeScript SDK (Tier 1) | The 2026-07-28 stateless pivot rewrote the protocol's session model, handshake, and transport rules in one revision, with a 7-row era-compatibility matrix and typed negotiation-by-error; the Tier-1 SDK is contractually maintained against that churn (SDK tiering with relegation, SEP-1730) and the spec is conformance-test-gated per SEP (FACT, research/notes/mcp-protocol.md §12, §16). Reimplementing era detection and dual-era behavior is pure cost. | Coupled to their release cadence; a future pivot of similar magnitude lands on our schedule. Mitigation: the SDK is confined inside the MCP capability provider; kernel code never sees MCP types. |
| A2A | **ADOPT** official SDK; **INTEGRATE at the edge** (client role: remote agents as capabilities); **DEFER server projection** to Wave 5 | A2A's task lifecycle is the substrate our invocation algebra extends (spine §3.3); the SDK gives tri-binding conformance and the 0.3-compat mode for free (FACT, research/notes/a2a-protocol.md F11). Projecting Kyxo cells *as* A2A servers is valuable but not on the critical path. | Observed SDK/spec drift (`TASK_STATE_ERROR` docstring vs proto — SOURCE-CODE OBSERVATION, a2a-protocol.md F11); 1.0 was a breaking release and extensions may add states (F10), so our mapping table must pin spec versions. |
| Journal store | **BUILD thin over SQLite**; **ADOPT Postgres as a second backend later** behind the storage interface | The record-and-inject journal with a two-tier reference/payload split *is* the product (spine H5, §6.5); no off-the-shelf store implements our envelope, and DBOS demonstrates that one database + a thin library is a sufficient durable substrate at >40K steps/s (FACT, research/notes/durable-execution.md §4). | Hand-rolled durability correctness. Mitigation: conformance-tested storage interface (LangGraph checkpointer precedent, spine §8) plus Wave-1 crash-resume fuzzing; kill-signal in risk R9. |
| CAS (content-addressed store) | **BUILD thin** (hash → file; later hash → object store) | Content addressing is trivial; the value is enforcing the two-tier discipline from day one — every durable-execution system retrofitted a claim-check because payloads-in-the-log is the recurring pathology (51,200-event caps, 2 MB payloads, base64 tax — FACT, durable-execution.md §1–2, Implication 2). | GC/retention is the genuinely hard part and is deliberately deferred; risk is unbounded disk growth in V1. Accepted for single-node V1 with a manual `kyxo gc` escape hatch. |
| Workflow engine | **BUILD-as-strategy** (graph/workflow runner is userland over the kernel); explicitly **NOT ADOPT Temporal for the kernel**; **INTEGRATE later**: document hosting Kyxo cells under external durable engines | See the full block below. | We rebuild journaling machinery Temporal has hardened for a decade. Bounded by scope: single-node, leases, idempotency keys, no mesh — and the INTEGRATE path is the hedge if our durability layer stalls. |
| Tracing | **ADOPT OpenTelemetry** (export-only) | OTel is the only observability surface every studied system converges on: MCP reserves `traceparent`/`tracestate`/`baggage` in `_meta` (SEP-414), A2A delegates observability to W3C Trace Context/OTel by documentation, Temporal ships a replay-safe OTel tracer (FACT, mcp-protocol.md §4; a2a-protocol.md F-vocab; durable-execution.md vocab). Spine §2: observability is a *projection of the journal*, never a second event bus. | GenAI semantic conventions still moving. Keep the exporter a thin projection so semconv churn touches one module. |
| Model APIs | **WRAP provider SDKs; BUILD model adapters** | Model interaction paradigms diverge on 16 axes; LCD flattening fails loudly (Gemini signature 400s, DeepSeek `reasoning_content` 400s) and silently (dropped reasoning measurably degrades results) (FACT/OBSERVED BEHAVIOR, research/notes/open-model-infrastructure.md §5, §10). The adapter — encode/decode + manifest + opaque carry-through — is kernel-adjacent product surface; the raw HTTP client is not. | Adapter maintenance burden tracks provider drift (parser breakage across DeepSeek v3→v3.2 is documented — open-model-infrastructure.md OQ2). Mitigation: probe suite + outcome telemetry detect drift before users do; see risk R6. |
| Sandbox | **ADOPT OS primitives** (seatbelt, Landlock/seccomp, AppContainer) + **EXTEND Codex/Claude-Code patterns** (policy-tiered escalation, approval-gated escape); **DEFER WASM**. **Schedule moved forward by amendment A6:** the OS-sandbox enforcement floor under shell and HTTP ships **with the capability tier in Wave 2**, not in the Wave-4 hardening pass | Competitive coding agents shipped working OS-primitive sandboxes with policy tiers (spine H1/H2 evidence base); WASM component hosting is the declared extension path (spine §8) but its crossing-cost question is deliberately deferred to the wave that measures it (Wave 5 spike). A6's reason for pulling the floor forward: until an effectful capability is bounded by something it cannot decline to call, the grant claim (F7 in doc 14) is a claim about cooperative code — which is exactly what a middleware retrofit into LangGraph or MAF already offers, so shipping without it would leave the BUILD case resting on a discriminator the review retracted. | Platform fragmentation (three OS mechanisms, three behaviors); sandbox tiers must be conservative-by-default or they become theater. Pulling the floor into Wave 2 also front-loads the credential-proxy and egress-allowlist machinery, which is new risk surface in the wave that already carries adapter fidelity — priced in R12. |
| Licensing, governance and marks | **ADOPT standard instruments; BUILD nothing** — Apache-2.0 for code, an open specification licence for schemas/fixtures/facade, DCO, an existing-practice spec-change process, and a foundation home on a pre-committed trigger | Amendment A5 makes governance a Wave-0 deliverable with the same priority as the schema freeze, and none of it is product surface: every instrument here has a well-tested off-the-shelf form, and inventing bespoke ones would signal exactly the unilateral ownership that would keep the record format from being adopted as a format. MCP and A2A both ended in foundation homes (FACT); deciding our trigger before we need it is free now and expensive later. | Governance is cheap to write and expensive to mean: a conformance mark nobody withholds is decoration, and a spec process without named maintainers is a README. Kill-signal and tracking in R11. |
| Auth | **ADOPT OAuth 2.1 libraries** | MCP mandates OAuth 2.1 RS + RFC 9728/8707/9207 + CIMD, with DCR already deprecated (FACT, mcp-protocol.md §11); A2A declares OpenAPI-style schemes at the HTTP layer (FACT, a2a-protocol.md F9). Hand-rolling auth is a security anti-decision. | CIMD is still a draft; auth extension churn (EMA, client-credentials ext). Confine to the edge; Grants — our authority model — are kernel-internal and unrelated to wire auth. |
| Container runtime | **DEFER** | Execution environments are leasable capabilities (spine §2); V1 is single-node with process sandboxes. Container/VM environments arrive as capability providers, not kernel features. | None material in V1; the deferral is cheap because the environment contract is already a manifest. |
| Vector DB | **DEFER** | Retrieval is a capability; memory is labeled state cells (spine §5). The kernel owns neither embeddings nor indexes. Embed/rerank are first-class *invocation profiles* (spine §4), which is all the kernel needs to know. | Ecosystem expectation mismatch ("where's the RAG?"); answered by docs 09-CONTEXT-AND-MEMORY positioning, not code. |
| Constrained decoding | **INTEGRATE xgrammar-class engines via open-model serving** | XGrammar is already the default structured-output backend of vLLM/SGLang/TensorRT-LLM/MLC-LLM (FACT, open-model-infrastructure.md §4); the kernel models grammar expressivity as a negotiated axis with tiers (CFG > regex > schema-subset > json-mode > none) and treats constrained decoding as verification at the model boundary. | Only exists where logit access exists; the same guarantee on closed APIs degrades to post-hoc validate+retry at different cost — the negotiation layer must price that difference, not hide it. |
| Eval harness | **BUILD minimal** | The benchmark matrix (`model × harness`) is expressible precisely because both are capabilities with manifests (spine §9); no external eval framework understands our Binding/Grant/journal objects. Minimal = matrix runner + fixture objectives + journal-derived scoring, nothing more. | Eval scope creep is a classic sink; the kill-signal is the runner growing opinions about *tasks* rather than *plumbing*. |

### Why not Temporal for the kernel (the contested row)

```
Evidence      — All three durable-execution vendors impose deterministic orchestration +
                journaled effects, and their 2025–26 AI integrations document the friction:
                WorkflowSafeMemorySession rebuilt because host state isn't replay-safe and
                dying at Continue-As-New; HITL requiring serialized RunState bound to the
                exact tool-graph identity; usage accounting silently lost across the activity
                boundary; 2 MB payload caps and 51,200-event history limits hit by
                conversation data; stateful MCP connections requiring a pinned-worker hack;
                ~100 lines of docs on patch-marker edge cases (FACT throughout,
                research/notes/durable-execution.md §1–2). The note's root-cause reading:
                Temporal assumes code is the durable artifact and data flows through it;
                agent workloads invert this (INFERENCE/HIGH, §2).
Interpretation— Positional-replay determinism is a tax proportional to code volatility, and
                AI orchestration code (prompts, model wiring, tool schemas) is the most
                volatile code in the industry. Record-and-inject journaling (Restate-shaped)
                plus checkpoint-lookup (DBOS-shaped) achieve the same recovery invariant
                without making the harness configuration a durable contract.
Implication   — The kernel BUILDs a journal-first store per spine H5 and never adopts a
                replay-first engine as its substrate. Temporal-class engines remain
                INTEGRATE targets in two directions: (a) a Kyxo cell hosted inside an
                external engine's effect unit (activity/handler) for shops standardized on
                Temporal — documented, not built, until demand exists; (b) their operational
                verbs (Restate 1.6 restart-from-journal-point, DBOS fork) are the design
                brief for our checkpoint/fork verbs.
Confidence    — HIGH. This is the best-evidenced negative decision in the program; the
                counter-case (their decade of hardening) is priced in risk R9.
```

### Why the official MCP SDK despite the churn

```
Evidence      — MCP executed a breaking architectural rewrite (sessions removed, handshake
                removed, MRTR replacing server-initiated requests, resumability deleted)
                sixteen months after adding some of those features, and shipped the
                compatibility path in the same revision; deprecation windows are 12 months
                minimum and conformance scenarios gate SEP finalization (FACT,
                research/notes/mcp-protocol.md §1, §12, §16).
Interpretation— The protocol will keep moving, but the governance machinery makes the
                movement trackable — and the SDK tier system makes tracking someone else's
                funded job. The churn is an argument FOR adopting and AGAINST wrapping the
                wire format ourselves.
Implication   — Adopt the TypeScript SDK inside the MCP capability provider; forbid MCP
                types north of the provider boundary; pin spec revisions in the provider's
                manifest so negotiation can express "speaks 2026-07-28 and 2025-11-25".
Confidence    — HIGH.
```

---

## 2. Implementation waves (Phase 30)

Six waves, 0–5. **This numbering is canonical** (amendment A7): where `14-MVP-ARCHITECTURE.md`
previously staged deferrals on a different three-wave scale, its labels have been rewritten in
these terms, and the MVP of that document is Waves 0–3. Each wave ends in something usable and
testable on its own; no wave's exit criteria depend on a later wave. The two standalone-value bets
are deliberate: Wave 0's frozen record format is publishable without any kernel (spine §6.5 —
durable execution has no MCP-equivalent), and Wave 2's manifest catalog + probe suite is usable by
people who never run Kyxo (open-model-infrastructure.md, Implication 10: nobody negotiates today;
accurate manifests for the top targets are immediate value) — bounded, per amendment A14, to the
four MVP adapters, because a catalog is a maintenance commitment and an unmaintained one is worse
than none.

```mermaid
graph LR
    subgraph W0G["Wave 0 — freeze, three surfaces + governance"]
        W0A["Wire schemas v0<br/>envelope · manifest grammar ·<br/>lifecycle · checkpoint"]
        W0B["Frozen facade (A4)<br/>KernelApi / InvokeCtx / HarnessCtx<br/>+ conformance fixtures"]
        W0C["Governance (A5)<br/>Apache-2.0 + spec licence · DCO ·<br/>marks · spec process · neutral-home trigger"]
        W0D["Semantic property-test spec (A1)<br/>journal · checkpoint · fork · dedup<br/>EXIT GATE — BUILT, passing"]
    end
    W0G --> W1["Wave 1<br/>Kernel core"]
    W1 --> W2["Wave 2<br/>Capability tier<br/>+ enforcement floor (A6)"]
    W2 --> W3["Wave 3<br/>Strategy tier<br/>+ telemetry ranking (A13)"]
    W3 --> W4["Wave 4<br/>Hardening"]
    W4 --> W5["Wave 5<br/>Ecosystem"]
    W0G -.->|"fixtures reused by every wave"| W5
    W2 -.->|"manifest catalog (4 adapters, A14)<br/>ships standalone"| PUB1(["public artifact"])
    W0G -.->|"record format + facade<br/>ship standalone"| PUB2(["public artifact"])
    W0D -.->|"discharged early:<br/>prototypes/kernel-semantics"| DONE(["docs 17 · 18 · 20"])
```

### Wave 0 — Protocol, facade and governance freeze v0

- **Goal.** Freeze the contracts before any kernel code exists to ossify around accidents. Four
  workstreams, and amendments A4/A5/A1 make the last three co-equal with the first rather than
  follow-ons:
  1. **The wire-visible contracts** — event envelope, manifest grammar, invocation lifecycle
     machine, checkpoint schema — as versioned JSON-Schema (2020-12) artifacts with conformance
     fixtures. This is the anti-Codex move: their SQ/EQ protocol drifted per release because it
     was never a spec (spine §8); ours is a spec before it is an implementation.
  2. **The facade** (amendment A4). The wire schemas alone never covered what a provider or a
     strategy actually programs against, so `KernelApi` / `InvokeCtx` / `HarnessCtx` are frozen
     here too: versioned, conformance-tested, with the same stability classes and deprecation
     clock. The normative verb list — decided by what the four phase-1 prototypes demonstrably
     needed — is bind, invoke, resume (with re-grant option), cancel, attenuate, getGrant
     (handle-shaped, A8), charge, storeArtifact/readArtifact, scoped journal read, checkpoint,
     createCell, discovery (listCapabilities), the Kind verbs
     (registerKind/createKindObject/getKindObject/watch), and an injected clock. `InvokeCtx` is
     **data only** — no kernel handle reaches a capability, which is what makes the commit barrier
     structural rather than cooperative. ADR-010's replaceability claim stays scoped to the
     execution record until these fixtures exist; with them, "the TypeScript kernel is replaceable"
     becomes a testable statement instead of an intention.
  3. **Governance** (amendment A5), with the same priority as the schema freeze — see the dedicated
     bullet below.
  4. **The executable semantic spec** (amendment A1) as this wave's hardest exit gate — see below.
- **Architecture introduced.** Date-versioned kernel protocol with stability classes
  (experimental/testing/stable/deprecated, 12-month deprecation floor — MCP's lifecycle
  lifted verbatim, mcp-protocol.md §12). Two-tier event envelope (payloads by Artifact
  reference; correlation/causation/actor IDs). Three-tier manifest grammar (typed named axes
  / `experimental` bag / governed reverse-DNS extensions — the shape that survived MCP's
  full rewrite, FACT, mcp-protocol.md §3). Closed transition algebra extending A2A's states
  with `approval-required` and `budget-exceeded` in the interrupted class (spine §3.3;
  a2a-protocol.md F2 documents that A2A's own machine is deliberately permissive —
  INFERENCE/HIGH there — and OQ1 asks for exactly the closed algebra we are freezing).
  **GREASE from v0**: reserved axis values and extension IDs that conforming implementations
  must ignore, injected randomly by the fixture generator so intolerant parsers fail in
  CI rather than in the field three years from now (TLS's lesson, spine §3.2).
- **Code introduced.** `kyxo-protocol` package: schemas, TypeScript types generated from
  them, a fixture corpus (valid, invalid, greased, and future-versioned envelopes), a
  validator CLI, golden serialization vectors. No runtime code.
- **Dependencies.** None. Inputs: spine §§3–4, docs 05-KERNEL-PRIMITIVES,
  06-CAPABILITY-SPEC, 08-EVENT-AND-STATE-MODEL (schemas here must match their prose; any
  divergence is a bug in one of the two and goes to 16-ADR).
- **Risks.** Protocol-freeze-too-early (risk R2) — mitigated by stability classes: v0 freezes
  the *envelope and grammar*, not the axis vocabulary, which stays `testing` until Wave 2
  probes have validated it against real targets. Over-specification — mitigated by the rule
  that nothing enters `stable` without two consumers.
- **Tests.** Fixture validation in CI; round-trip property tests (parse∘serialize = id);
  must-ignore-unknown tests; GREASE tolerance tests; a negative suite proving the lifecycle
  machine rejects illegal transitions (terminal states are sinks; interrupted states resume
  only via typed payloads).
- **Exit criteria.** v0 schemas tagged. A second, independent implementation of the fixture
  parser (generated Python, no shared code) passes the full corpus — the proof that the
  record format is implementation-independent, which is the property we intend to sell.

### Wave 1 — Kernel core

- **Goal.** The nine kernel objects and two mechanisms (spine §3) running single-node:
  journal, cells, invocations, grants, policy pipeline, checkpoints, over SQLite + file CAS.
- **Architecture introduced.** Record-and-inject journaling (effects journaled with
  idempotency keys; resume injects recorded outcomes — the Restate/DBOS-shaped invariant,
  durable-execution.md §7, without positional command matching). Single-writer cell
  scheduler with activation-on-demand (the Orleans/Virtual-Object/Entity-Workflow
  convergence, INFERENCE/HIGH, durable-execution.md §6). Grant lineage tree with
  reserve-at-lease/settle-at-outcome accounting (amendment A2) and mandatory attenuation on delegation. Ordered policy pipeline
  evaluated at bind and at every effectful invocation, deny-class stages non-bypassable.
  Checkpoint = journal position + state snapshot + pending invocations, bound to definition
  identity. Leases with visibility timeouts on every external effect; dedup windows with
  documented retention (the TTL-vs-retry-window coupling is a real correctness knob —
  durable-execution.md §2 on Workflow Streams).
- **Code introduced.** `kyxo-kernel`: journal + storage interface + SQLite backend, CAS,
  scheduler, lifecycle machine, grant table, policy pipeline, checkpoint cut/fork. A
  storage-conformance suite any future backend (Postgres) must pass.
- **Dependencies.** Wave 0 schemas (the kernel implements them; it does not define them).
- **Risks.** Hand-rolled durability bugs (R9). Scope creep toward distribution — explicitly
  out (spine §8: single-node; distribution = portable checkpoints + protocol edges).
- **Tests.** Property tests: the transition algebra is closed under all event sequences;
  child grant ≤ parent on every delegation path; at-least-once delivery + idempotency keys
  yields exactly-once observable effects under injected duplicates. **Crash-resume fuzzing**:
  kill the process at randomized points (including mid-commit), resume, assert journal
  consistency, no double-charged budgets, no orphaned leases — thousands of cycles in CI.
- **Exit criteria.** A scripted cell performing journaled effects survives 10,000 randomized
  crash-resume cycles with zero divergence; a checkpoint cut mid-run forks into a new cell
  that completes identically; budget exhaustion mid-invocation lands in `budget-exceeded`
  (interrupted), never in an inconsistent journal.

### Wave 2 — Capability tier

- **Goal.** Real capabilities behind real manifests: **model adapters ×4** spanning the
  dialect space — Anthropic Messages, OpenAI Responses (stateful + encrypted-reasoning
  modes), one OpenAI-compat open engine (vLLM, including `extra_body` extensions and
  structured-outputs tiers), Ollama native (the resource-lifecycle outlier: `keep_alive`,
  `num_ctx`) — plus the four standard tool-runtime providers: **shell, HTTP, MCP client,
  human** (elicitation-shaped, form/URL split so secrets never transit the runtime —
  mcp-protocol.md §6). Probe suite. **The manifest catalog for top targets — standalone
  value.**
- **Architecture introduced.** Live negotiation: axis intersection at bind time, sealed
  Bindings, fail-loud on missing required axes (the silent-degradation ban, spine §4).
  Typed provider-native passthrough (the `extra_body` pattern made honest). Opaque
  carry-through artifacts for provider state — reasoning items, thinking signatures, thought
  signatures — provenance-bound to (provider, model, position) and never sanitized away
  (the 400-class failures are the enforcement evidence: OBSERVED BEHAVIOR/HIGH,
  open-model-infrastructure.md §5). Probe invocations as cacheable evidence artifacts.
- **Code introduced.** Adapter framework + four adapters; four tool-runtime providers;
  `kyxo probe` runner; the catalog repository (static manifests, indexed without execution).
- **Dependencies.** Wave 1 kernel; Wave 0 manifest grammar.
- **Risks.** Catalog maintenance burden begins here and never ends (R6). MCP SDK coupling
  surfaces here (contained per §1). Adapter fidelity: an adapter that misdeclares an axis
  poisons negotiation — hence probes gate catalog entries.
- **Tests.** Probe suite against recorded wire fixtures and (nightly, allowlisted) live
  targets; negotiation matrix tests including mandatory-failure cases (required axis absent
  → loud bind error with the missing axis named) and GREASE injection; carry-through tests
  proving opaque artifacts survive journal round-trips and are refused across model
  boundaries.
- **Exit criteria.** `kyxo probe <target>` emits a manifest that round-trips through
  negotiation; the catalog covers the top targets across all four dialect families and is
  published as a standalone artifact; one end-to-end journaled invocation through every
  adapter and provider, surviving a crash-resume mid-invocation.

### Wave 3 — Strategy tier

- **Goal.** The stdlib strategies as behaviours over the kernel: `ReactiveHarness`,
  `PlanExecuteHarness`, the graph runner, the loop runner — and the DX contract:
  `runtime.run({ objective })` with the default profile works (spine §9). Benchmark matrix
  MVP.
- **Architecture introduced.** The behaviour contract (kernel/stdlib owns event intake,
  yield-is-commit checkpointing, budget charging, cancellation; the harness supplies
  callbacks — spine §2, §5). Dynamic invocation spawn with deterministic identity
  (uuid5-style derivation) so graphs and generated code are frontends over one dispatch
  mechanism. Pluggable termination/continuation policies. Profiles bundling strategy +
  policy + budget defaults.
- **Code introduced.** `kyxo-stdlib` strategies; profile system; the `kyxo run
  objective.yaml` CLI path (see §3); benchmark matrix runner (model × harness over
  capability manifests) — the doc-37-scope MVP, journal-derived scoring only.
- **Dependencies.** Waves 1–2 (harnesses invoke model adapters and tool runtimes as
  capabilities; nothing else).
- **Risks.** DX complexity creep (R3) — the default profile is the tripwire. C2 discipline:
  harnesses are model-paired and benchmarked, never advertised as universal; the matrix
  exists to make the pairing empirical (spine H1/C2).
- **Tests.** Golden-transcript tests per strategy (journal in → deterministic projection
  out); suspension/resume through every interrupted state including `approval-required` and
  `budget-exceeded`; checkpoint-fork mid-strategy resuming on a fresh process; matrix run
  over ≥2 models × 2 harnesses producing comparable artifacts.
- **Exit criteria.** `kyxo run objective.yaml` with zero configuration completes a
  nontrivial multi-tool objective under default budgets; the same run killed at an arbitrary
  point resumes from its last checkpoint; the benchmark matrix emits a reproducible report
  addressed by (model, harness, objective, config-hash).

### Wave 4 — Hardening

- **Goal.** The security invariants stop being declarations: taint labels end-to-end,
  redaction, sandbox tiers, budget-exhaustion chaos.
- **Architecture introduced.** Structural taint/integrity/confidentiality propagation across
  artifacts and compiled context, with declared endorsement as the only downgrade path
  (spine §3.5 — replacing the retrofit-scanning pattern). Sandbox tiers keyed to grant risk
  class (OS primitives per platform; approval-gated escalation per the Codex/Claude-Code
  pattern). Redaction at the journal boundary: secrets are never in the truth plane, so
  they can never leak from it. Supervision with restart-intensity budgets extended to
  token/cost, escalating to parent cells or humans (the OTP complement no durable runtime
  has — INFERENCE/HIGH, durable-execution.md §6, Implication 6).
- **Code introduced.** Label propagation in kernel paths; sandbox providers; redaction
  filters; a chaos harness (spawn storms, token exhaustion mid-invocation, grant revocation
  mid-flight, clock skew, storage-full).
- **Dependencies.** Waves 1–3 (there must be strategies worth attacking).
- **Risks.** Kernel-crossing overhead becomes measurable here for the first time (R4) —
  this wave produces the baseline the Wave-5 WASM spike is compared against. Over-tainting
  making the system unusable — the usability counter-metric is tracked alongside soundness.
- **Tests.** Taint-flow property tests (no untainted output derivable from tainted input
  without an endorsement event in the journal); a red-team fixture set (prompt-injected tool
  output attempting exfiltration and privilege escalation) that must fail closed; sandbox
  escape suite per platform; budget-exhaustion chaos runs asserting every exhaustion lands
  in the interrupted class with intact lineage.
- **Exit criteria.** Published crossing-cost benchmark (in-process reference passing vs
  process-isolated capability); red-team suite green; a full benchmark-matrix run under
  chaos injection completes with zero journal inconsistencies.

### Wave 5 — Ecosystem

- **Goal.** Python SDK; A2A server projection; registry; WASM isolation spike; self-hosting
  dogfood.
- **Architecture introduced.** Protocol-first pays off: the Python SDK is a second client of
  the versioned kernel protocol, not a port of the TypeScript code. The A2A projection maps
  cells to A2A tasks — our lifecycle projects onto A2A's states by construction because it
  extends them; `approval-required`/`budget-exceeded` surface via A2A's extension mechanism
  (URI-keyed metadata; state-machine extensions are sanctioned — FACT, a2a-protocol.md F10).
  Registry: static manifests, DNS-verified namespacing, indexed without execution — the
  static/dynamic split MCP's registry and `server/discover` model proved (INFERENCE/MEDIUM,
  mcp-protocol.md §15). WASM spike: host one capability provider as a WASM component and
  measure against the Wave-4 baseline.
- **Code introduced.** `kyxo-py`; A2A projection service; registry service + CLI; WASM host
  spike; the dogfood configuration.
- **Dependencies.** All prior waves; the projection additionally depends on the Wave-0
  lifecycle mapping table.
- **Risks.** Ecosystem investment ahead of adoption signal (R1's kill-signal is read here);
  A2A/MCP convergence churn could obsolete parts of the projection (a2a-protocol.md OQ3).
- **Tests.** Cross-SDK conformance (both SDKs against the same Wave-0 corpus); A2A
  compatibility against official SDK clients across all three bindings; WASM spike
  benchmark; dogfood runs under full Wave-4 policy.
- **Exit criteria.** An external, unmodified A2A client drives a Kyxo cell through the full
  lifecycle including an interrupted-state round-trip; the Python SDK passes the conformance
  corpus; registry serves the Wave-2 catalog. **Dogfood (Phase 38):** a Kyxo-hosted coding
  harness proposes an improvement to the Kyxo repository that lands through the verification
  commit gate. The architecture permits this by construction — harnesses are capabilities,
  grants attenuate, verification gates promotion — and the wave schedules the attempt; it
  makes **no promise** of the outcome. Self-hosting is a probe of the design, not a success
  criterion.

---

## 3. Deployment architecture (Phase 31)

One codebase, four modes. The kernel is a library first; every other mode is a thin host
around the same objects, differing only in process boundary and principal model. There is
**no Kubernetes requirement anywhere**: a complete Kyxo deployment is one binary, one SQLite
file, one CAS directory.

```mermaid
graph TB
    subgraph one_codebase["one codebase: kyxo-kernel + kyxo-stdlib + kyxo-protocol"]
        K["Kyxo kernel<br/>(journal · cells · grants · policy · checkpoints)"]
    end
    LIB["Embedded library<br/>in-process, reference-passing crossings"] --> K
    CLI["CLI: kyxo run objective.yaml<br/>ephemeral kernel, exits with the run"] --> K
    D["Local daemon (kyxod)<br/>shared journal, surfaces attach via event protocol"] --> K
    SRV["Server mode<br/>multi-principal, OAuth edge, MCP/A2A projections"] --> K
```

- **Embedded library.** `runtime.run({ objective })` inside a host application. Crossings
  are in-process reference passing (zero-cost, spine §8); the journal is a local file. This
  is the mode the DBOS evidence validates: a library plus one database is a sufficient
  durable kernel, with distributed concerns out-of-band (FACT/INFERENCE-HIGH,
  durable-execution.md §4).
- **CLI.** `kyxo run objective.yaml` is the north-star simple case: parse the objective,
  assemble the default profile, run one cell, stream the advisory plane to the terminal,
  leave the journal + checkpoints on disk so `kyxo resume` and `kyxo fork` work afterward.
  If this command ever requires a daemon, a container, or a cloud account, risk R3 has
  fired.
- **Local daemon (`kyxod`).** Long-lived cells (sessions, memory, scheduled work) shared by
  CLI invocations and local apps. Surfaces attach via the same versioned event protocol —
  the Codex App-Server precedent (spine §8) with the drift failure fixed by Wave 0's frozen
  schema. stdio and local HTTP transports; same journal format as every other mode.
- **Server mode.** The same daemon with a principal boundary: OAuth at the edge (adopted
  libraries, §1), Grants minted per principal, MCP southbound and the A2A projection
  northbound (Wave 5). Postgres storage backend when concurrency demands it — a storage
  interface swap, not an architecture change.
- **Enterprise topology (sketch, deferred).** Multi-node = portable checkpoints + protocol
  edges, never an in-kernel mesh (spine §8; MAF killed theirs). The sketch: N server-mode
  nodes over shared Postgres + object-store CAS; a shared registry; provider-side execution
  domains federated as remote cells (spine §5). Deliberately unscheduled: no wave builds
  it, and it stays a sketch until a real deployment demands it — designing it now would be
  speculation compounding on speculation.

```
Evidence      — DBOS ships durability as a library over the user's Postgres with an
                out-of-band control plane; Restate is a single binary; MCP's 2026 pivot
                optimized for gateway/middlebox deployment; Temporal's server+worker+queue
                topology is the outlier and its AI integrations carry the most ceremony
                (FACT across research/notes/durable-execution.md §§1–4,
                research/notes/mcp-protocol.md §10).
Interpretation— Adoption of infrastructure this low in the stack tracks time-to-first-value;
                topology-heavy systems get adopted by platform teams, library-shaped systems
                get adopted by developers — and frameworks (our competition, risk R1) are
                adopted by developers.
Implication   — Library-first, daemon-optional, server-capable, Kubernetes-never-required.
                The four modes share one journal format so a run started in the CLI can be
                resumed under the daemon: deployment modes are views over the record, not
                different systems.
Confidence    — HIGH for library-first; MEDIUM for the enterprise sketch (deferred
                precisely because evidence there is thinnest).
```

---

## 4. Risk register

Top 10. Likelihood/impact on a L/M/H scale; every risk carries a kill-signal — the
observable that says the mitigation failed and the strategy, not the execution, must change.

| # | Risk | Likelihood | Impact | Mitigation | Kill-signal |
|---|---|---|---|---|---|
| R1 | **Adoption vs frameworks.** Developers default to LangGraph/MAF/vendor SDKs; a kernel beneath frameworks is invisible to them | H | H | Standalone-value artifacts that don't require betting on Kyxo (record format, manifest catalog + probes); INTEGRATE posture toward frameworks (they are strategies/adapters, not enemies — spine §10); library-first deployment (§3) | Wave-2 catalog and Wave-0 format each fail to attract any external consumer within two quarters of publication |
| R2 | **Protocol-freeze-too-early.** v0 enshrines wrong axes/envelope fields; MCP's 16-month rewrite shows even well-governed protocols get it wrong first (FACT, mcp-protocol.md §1) | M | H | Stability classes with `experimental`→`stable` promotion gated on two consumers; GREASE from v0 keeps the ecosystem tolerant of change; 12-month deprecation clock; Wave-2 probes validate axes against reality before they harden | A Wave-3+ feature requires a breaking envelope change to a `stable` schema — i.e., the escape valves (extensions, experimental bag) proved insufficient |
| R3 | **DX complexity creep** (spine C4). Nine kernel objects leak into the simple case; `kyxo run` grows mandatory flags | H | H | The default profile is CI-enforced: `kyxo run objective.yaml` with zero config is an integration test from Wave 3 onward; profiles absorb complexity; advanced surface is the same objects, explicit | The zero-config test needs its fixture "simplified" to keep passing, or first-run-to-first-result exceeds minutes |
| R4 | **Kernel-crossing overhead when isolation lands.** Zero-cost in-process references hide a cost model that process/WASM isolation exposes (the Mach/L4 lesson, spine §3.5) | M | M | Two-tier envelope keeps payloads out of crossings by construction; Wave 4 publishes the crossing benchmark; Wave 5 WASM spike measures before any commitment | Isolated-capability overhead exceeds low-single-digit % of end-to-end turn latency on the benchmark matrix, and artifact-reference passing can't close the gap |
| R5 | **Provider-runtime absorption outpacing the kernel.** Responses-style state, hosted tools, server-side compaction absorb the layer we're building (spine §5) | M | H | Providers-as-remote-cells federation stance (mirror artifacts/budgets/policy rather than proxy); the cross-provider record, grants, and verification remain outside any one provider's reach by construction | A major provider ships cross-provider budgets/lineage/verification — the gap map (spine §6) loses rows to a platform we can't federate with |
| R6 | **Negotiation catalog maintenance burden.** Manifests for N targets × M axes decay continuously; parser/format drift is documented (open-model-infrastructure.md OQ2) | H | M | Probes generate manifests (humans review, machines produce); outcome telemetry flags manifest-vs-reality divergence in the field; catalog scoped to top targets, community PRs for the tail | Catalog staleness becomes the top user complaint, or maintenance consumes a full engineer indefinitely while the axis set is still churning |
| R7 | **Reference-kernel replaceability proves theoretical.** TypeScript kernel accretes behavior the schemas don't capture; the "replaceable with Rust" claim (spine §8) silently dies | M | M | Wave-0 independent-parser exit criterion; conformance corpus grows with every wave; storage interface conformance suite; behavior-not-in-a-fixture treated as a bug | The Python SDK (Wave 5) needs TypeScript-implementation knowledge — not just schemas — to pass conformance |
| R8 | **Edge-protocol churn.** MCP and A2A both shipped breaking rewrites within 18 months (FACT, mcp-protocol.md §1; a2a-protocol.md F1); our adapters and projection chase them | H | L–M | Official SDKs absorb wire churn (§1); protocol types confined to edge providers; spec revisions pinned in manifests and negotiated like any axis | An edge-protocol revision forces changes to kernel objects (not just edge providers) — the containment boundary failed |
| R9 | **Hand-rolled durability correctness.** Our journal/lease/dedup machinery has the bug classes Temporal spent a decade fixing | M | H | Narrow scope (single-node, no mesh, no positional replay); crash-resume fuzzing from Wave 1 as a permanent CI gate; storage conformance suite; INTEGRATE hedge (cells under an external durable engine) documented | A journal-consistency bug reaches a user despite the fuzz gate, or fuzzing keeps finding new invariant violations after Wave 2 — the invariant set itself is wrong |
| R10 | **Security model unsound or unusable.** Taint + grants either leak (unsound) or over-restrict until users bypass them (unusable — the historical ocap failure mode) | M | H | Wave-4 red-team fixtures as permanent regression suite; usability counter-metric (endorsement events per successful run) tracked beside soundness; deny-class stages non-bypassable so bypass attempts are at least visible | Default profiles need blanket endorsements to stay usable, or the red-team suite is green while a novel exfiltration class succeeds in dogfooding |

The register's overall shape: the *execution* risks (R7, R9) have strong mechanical
mitigations and are the ones we control; the *strategic* risks (R1, R5) do not, which is why
both are wired to standalone-value artifacts whose adoption is measurable early. R1 is the
program's dominant risk and the reason Waves 0 and 2 are sequenced to produce public
artifacts before the kernel is even interesting.

---

## 5. The exact next engineering step

Create the `kyxo-protocol` package and land the v0 JSON Schema for the Event envelope
(spine §3.4: type + version, correlation/causation/actor IDs, two-tier Artifact-reference
payload) together with its first ten conformance fixtures — including two GREASE fixtures —
and a CI job that fails on any fixture the schema does not validate.
