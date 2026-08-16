# 01 — Executive Thesis

Status: FINAL for the architecture phase (2026-08-16), written after the research sweep, the
document set, four passing prototypes, and the adversarial review. Labels follow
`research/METHODOLOGY.md`. This document is the program's answer sheet; everything it asserts
is elaborated and evidenced in docs 02–15, the ADRs, and `research/`.

---

## 1. Recommendation

**BUILD WITH CHANGES.**

The vote is not close, and it is not ours alone: the adversarial review's eight personas —
distributed-systems architect, AI infrastructure engineer, model-provider engineer, security
engineer, SDK/DX lead, enterprise architect, open-source maintainer, skeptical CTO — voted
**BUILD WITH CHANGES unanimously**, and answered the gate question ("useful primitive layer or
merely another abstraction layer?") **QUALIFIED-YES unanimously**. The qualifications were
specific, technical, and actionable; all seven FATAL findings and the load-bearing SERIOUS
findings are adjudicated as binding amendments A1–A14 in `research/DESIGN-SPINE.md` and
applied across the document set.

The changes that earn the "WITH CHANGES":

1. **Do not build a universal harness.** Harness quality is partly model coupling
   (Cursor: weeks of per-model adaptation, tools renamed to match RL training distributions,
   ~30% loss from dropping reasoning traces, a model trained inside the production harness —
   FACT/HIGH, `research/notes/cursor.md`). Kyxo hosts versioned, benchmarkable
   harness×model pairs on a model-independent substrate; it never promises model-independent
   harness quality.
2. **Do not invent wire protocols.** Speak MCP southbound, A2A at the federation edge,
   provider APIs through code-bearing adapters; project the internal invocation contract onto
   them as dialects (ADR-007).
3. **Claim enforcement only below the mediation waterline.** Every Binding carries a sealed
   guarantee grade — `enforced` / `observed` / `declared` — and the positioning claims
   kernel-grade enforcement for kernel-mediated execution (local tools, self-hosted models,
   sandboxed effects) and attestation + audit for delegated vendor harnesses and provider-side
   execution domains (amendment A3, from the review's strongest structural objection).
4. **Pull a non-cooperative enforcement floor into the MVP** (OS-sandboxed effectful
   capabilities with grant-scoped credentials/egress), because until isolation lands,
   cooperative-code-only enforcement is exactly what incumbent middleware already offers
   (amendment A6, from the CTO's fatal finding).
5. **Governance is a Wave-0 deliverable, not an afterthought** — license, DCO, conformance
   marks, spec process, pre-committed neutral-home trigger — because a substrate whose
   adoption strategy is "become the standard record format" cannot be unilaterally owned
   (amendment A5; MCP and A2A both required foundation homes, FACT).
6. **Single-node V1; TypeScript reference kernel; protocol-first with the facade frozen
   too** (amendments A4, A7; ADR-010 as revised).

**EXTEND was seriously considered and remains the documented fallback.** The honest
discriminators for BUILD over extending LangGraph or Microsoft Agent Framework are: (a) the
negotiation/manifest layer has no home in any incumbent kernel (LangGraph's kernel does not
know models exist — SOURCE-CODE OBSERVATION); (b) a clean-slate record format avoids being
hostage to a host framework's schema drift; (c) host-framework churn and governance exposure.
The earlier claim that grants and commit gates "cannot be retrofitted" was retracted under
review as the *sole* discriminator: they cannot be retrofitted *as kernel invariants*, but V1
Kyxo also binds only cooperative code until the enforcement floor and isolation waves — so the
claim now carries its own qualifier, and if the Wave-4/5 isolation measurements fail their
crossing-cost budget, the fallback (strategies + spec-only record format hosted on MAF or
LangGraph) triggers.

**DO NOT BUILD was rejected** because the gap map is real and evidenced by absence across
every system studied (§4 below), the kernel-shape is validated by four-way convergent
evolution rather than by our own taste, and the prototypes falsified the "it will need
type-dispatch anyway" null hypothesis concretely.

## 2. Problem and opportunity

**Problem.** Every serious AI execution stack rebuilds the same substrate — loop mechanics,
tool invocation, permissions, checkpoints, delegation, context assembly — welded to one
vendor's models, one framework's state schema, or one product's UX. The result is documented
in `docs/02`/`docs/03`: budgets that are env-var retrofits, verification that is "the agent
said done," capability discovery that is `/v1/models` returning bare IDs, delegation with no
attenuation, audit trails that cannot be replayed, and execution records that cannot leave the
framework that wrote them.

**Opportunity.** Independently and under production pressure, Google (ADK 2.0), Microsoft
(Agent Framework), LangChain (LangGraph's channel kernel), and Anthropic (Claude Code's
transcript+hooks core) all collapsed onto the same shape: a small typed-event/checkpoint
substrate with orchestration as userland (SOURCE-CODE OBSERVATION ×4, HIGH — the strongest
evidence class this program found). None of them finished the job: none owns budgets with
lineage, commit-point verification, capability negotiation, delegation attenuation, structural
provenance, or a portable record format. That six-item gap map, evidenced by absence in all
thirteen research notes, is the product surface of a kernel that does not yet exist.

## 3. The core architectural thesis

> Loop, graph, workflow, planner, supervisor, swarm, and **agent** are orchestration
> strategies. Model, tool, MCP server, remote agent, human, environment, and harness are
> **capabilities** under one negotiated contract. Beneath both sits a small deterministic
> kernel — nine objects, two mechanisms — that owns truth (journal), authority (grants),
> resources (budgets), recovery (checkpoints), and extension (kinds), and owns **no
> reasoning whatsoever**.

The nine kernel objects (`docs/05`): **Capability, Binding, Invocation, Event, Artifact,
Cell, Grant, Checkpoint, Kind** — each admitted only by Liedtke's minimality test (a concept
lives in the kernel only if userland implementations would break security, accounting,
recovery, or coordination). The two mechanisms: the ordered **policy pipeline** with
non-bypassable deny stages, and the **scheduler** (cell turns, leases, deadlines,
cancellation). Everything the mission listed as a candidate concept either maps onto these
(Evidence→Artifact kind; Task→Invocation; Identity→Grant lineage + actor IDs;
Objective→registered Kind over a root invocation) or is deliberately userland (Agent, Harness,
Graph, Planner, Memory tiers, Prompt).

**Prototype verdict** (all four pass, `prototypes/`): a raw LLM, a pure tool, an MCP-shaped
server, a harness-driven coding agent, a graph strategy, an opaque A2A remote, a human
approver, and an OpenAI-compat local model all execute through one `invoke()` path with a
grep-enforced ban on capability-type dispatch in the kernel; two harnesses with different
reasoning strategies are set-identical at the kernel boundary; a dynamic graph mutates under
evidence with full provenance; a bounded loop exhibits all five termination paths. The
prototypes also *falsified* parts of the design (missing re-grant verb, unfrozen facade,
voluntary commit gate, CAS dedup swallowing journal records) — those failures are amendments
now, which is precisely what prototypes are for.

## 4. What Kyxo owns that nothing else does

Each item is FACT-by-absence across the research corpus, with near-misses noted honestly:

1. **Grants**: unforgeable, attenuable authority + quantitative budgets (reserve/settle/release
   per A2) forming a delegation-spanning lineage tree. State of the art elsewhere: `max_turns`,
   `max_llm_calls`, env-var caps, per-run counters that leak across delegation (PydanticAI's
   own open issue).
2. **Commit-gate verification**: policy stages can require Evidence artifacts before an
   outcome enters truth or an artifact promotes. Absent in ADK, A2A, MCP, and every durable
   engine ("success = no exception").
3. **Axis-typed capability negotiation** with three information sources (declared / probed /
   observed) and a defined selection contract (A13). Nothing negotiates today; manifests are
   scoped to what the kernel can actually verify (A14).
4. **Structural provenance/taint** on artifacts and compiled context — an invariant, not
   middleware (FIDES exists as middleware; Claude Code retrofits text-scanning).
5. **A portable, published execution-record format** (journal + checkpoint + fork semantics
   per A1) — "durable execution has no MCP-equivalent" (`research/notes/durable-execution.md`).
6. **Delegation attenuation by construction** with journaled lineage — child authority ≤
   parent, recursion bounded by grant depth/width/budget, not by convention.

## 5. The strongest objections (verbatim substance, kept standing)

The review record (`research/ADVERSARIAL-REVIEW.md`) is part of this thesis; the five
objections below were the sharpest, and the design now carries their scars deliberately:

- **"The checkpoint composite's fork semantics were undefined at the one point the failure
  story rests on"** (distributed-systems architect, FATAL — upheld). Resolution: A1's
  lineage-scoped effect identity, journaled fork dispositions, compensation as normative
  repair for irreversible effects, and a Wave-0 executable property-test gate with an explicit
  reopen clause for ADR-002.
- **"You are selling kernel-grade enforcement while shipping declaration-checking for the
  growth path of the market"** (model-provider engineer, FATAL — upheld). Resolution: A3's
  guarantee grades and the rewritten positioning; V1 targets mediation-dominant segments;
  remote-domain share is tracked as the R5 leading indicator from day one.
- **"You froze the wire format and left unfrozen everything a developer actually touches"**
  (SDK lead, FATAL — upheld; the four prototypes changed the facade every time they touched
  it). Resolution: A4 freezes the facade as a Wave-0 conformance-tested contract with the verb
  list the prototypes demanded.
- **"Your own reference kernel commits the sin your ADRs use to disqualify incumbents —
  knowing a string is holding authority"** (security engineer — upheld). Resolution: A8's
  handle-shaped API.
- **"A schema you control unilaterally will not be adopted as a standard; MCP and A2A both
  needed foundation homes"** (open-source maintainer, FATAL — upheld). Resolution: A5's
  governance workstream at Wave-0 priority.

One objection is accepted as a permanent condition rather than resolved: **the differentiation
half-life.** MCP's tasks extension, possible MCP/A2A convergence, and providers absorbing
runtime features erode the gap map continuously. The mitigation is speed plus projection (the
kernel projects onto those protocols rather than competing with them), and the risk register
carries it with a leading indicator, not a promise.

## 6. Answers to the thirty questions

1. **What exactly constitutes an AI harness?** The opinionated layer that turns a model into a
   competent worker: context compilation, tool exposure, loop/termination policy, recovery.
   In Kyxo it is a behaviour contract over kernel-owned loop mechanics, and it is itself a
   capability — versioned, invocable, benchmarkable (`docs/10`).
2. **Where should the harness end and the runtime begin?** At accounting and truth: anything
   that charges budgets, appends truth-plane events, cuts checkpoints, or crosses a policy
   boundary is kernel/stdlib; anything that decides *what to do next* is harness (`docs/05`,
   `docs/10`).
3. **Is an agent a fundamental abstraction?** No. An agent is a configuration — harness +
   bound capabilities + grants + a cell. Four ecosystems independently demoted it
   (ADR-001).
4. **Is Capability a better primitive?** Yes — it is the only abstraction that covered all
   eight required constructs in the prototype without kernel type-dispatch, *provided* it
   carries per-consumer dialects and empirical telemetry, not just static declarations
   (ADR-003).
5. **Is Objective more fundamental than Prompt?** Yes; prompts are artifacts referenced by an
   Objective's intent. Objective is a registered Kind over a root invocation, not a kernel
   object (ADR-011).
6. **Graph: kernel primitive or orchestration strategy?** Strategy. LangGraph itself compiles
   graphs away at runtime; zero of the source-inspected coding agents contain one (ADR-004).
7. **Loop: kernel primitive or harness implementation?** Harness behaviour over kernel loop
   mechanics; every Phase-15 control compiled onto declarative policy in the prototype with
   zero kernel changes (`prototypes/loop`).
8. **Can graphs and loops be unified under one execution model?** Yes — both are strategies
   consuming the same kernel features (deterministic invocation identity, typed suspension,
   dynamic spawn, join barriers, yield-is-commit); demonstrated by prototypes sharing one
   kernel (`docs/04` §4).
9. **Should the runtime itself be event sourced?** Journal-first, yes — with checkpoint
   composites and lineage-scoped fork semantics (A1), not Temporal-style replay determinism
   (ADR-002/009).
10. **What must be deterministic?** Journal append/ordering, grant reserve/settle, policy
    evaluation, negotiation given manifests+probes, context compilation given sources,
    checkpoint/fork, scheduling decisions' record. The full table is `docs/07` §7.
11. **What should remain model-driven?** Everything that decides: planning, acting,
    termination judgment, delegation choices, memory salience, verification *judgment* (the
    gate is deterministic; judges are capabilities).
12. **How should context differ from memory?** Hard split: context is a deterministically
    compiled per-invocation view (pipeline, budgeted, provenance-labeled); memory is durable
    state cells that survive provider replacement (ADR-008).
13. **How should capabilities negotiate features?** Two-sided axis-typed tiered declared sets;
    must-ignore-unknown declarations; hard-error unsolicited use; GREASE from v0; fail-loud
    binding; probes and telemetry as the second and third information sources (`docs/06`).
14. **How do we avoid lowest-common-denominator portability?** Tiers instead of booleans, and
    a bind that refuses rather than degrades: a requirement the target lacks fails loudly at
    bind time; nothing is silently dropped (`docs/06`; the 16-axis evidence makes LCD
    provably lossy).
15. **How do provider-native features escape the abstraction?** Three layers: portable
    baseline axes → negotiated optional tiers → typed provider-native passthrough that is
    declared, policy-visible, and provenance-labeled — plus opaque carry-through artifacts
    for provider state (reasoning items, signatures) (`docs/06` §7).
16. **How do we run open and closed models equally?** Same manifest grammar, same adapter
    contract; open models differ by axes (grammar-tier constrained decoding, resource
    lifecycle) not by rank; the MVP's parity claim F4 is falsifiable with Gemini's
    signature-replay and vLLM's grammar tier in the same matrix (`docs/14`).
17. **How should remote agents/runtimes participate?** As opaque capabilities under the A2A
    task-lifecycle-shaped invocation contract, with signed manifests, guarantee grades, and
    verification-by-evidence instead of introspection (`docs/06` §10, `docs/07` §6).
18. **How should humans participate?** As capabilities with elicitation-shaped contracts,
    typed suspensions, deadlines/escalation — plus non-negotiable responsibility metadata;
    never anonymous tools (`docs/06`, `docs/11`).
19. **How do we resume after process/runtime failure?** Journal replay to rebuild projections,
    restore from the checkpoint composite, re-lease pending invocations under A1 dispositions;
    demonstrated across kernel instances in the prototype.
20. **How do we migrate execution between models?** Fork from checkpoint, re-bind the model
    requirement, re-compile context from cells; provider-opaque state degrades by declared
    contract (carry-through artifacts are provider-scoped) — migration is auditable and
    forkable, not lossless (`docs/09` §B6, honesty per review).
21. **How do we compare models independently of harness quality?** Fix the harness capability
    version, vary the model binding — the benchmark matrix is expressible because both are
    capabilities with manifests (`docs/14` §5).
22. **How do we compare harnesses independently of model quality?** The transpose. Per-pair
    behavior profiles legitimately vary prompts/dialects; the matrix measures adapted
    capability, and the comparability caveat is documented (`docs/10` §2).
23. **How do we prevent recursive agent explosions?** Grant attenuation: spawn depth/width and
    budgets divide along the delegation tree and are kernel-enforced at reservation time;
    exhaustion is a typed interrupted state, not a crash (ADR-014/015).
24. **How do we preserve security through nested delegation?** Attenuation by construction
    (child ≤ parent, always), lineage on every event, interposition invisible to holders,
    taint propagation across boundaries; the honest limit: kernel-issued authority only —
    brought/ambient credentials must be declared and confined (ADR-013 as revised).
25. **Can a capability dynamically create another capability?** Yes: registering a manifest is
    an ordinary policied invocation; the creator's grant bounds the creature's maximum
    authority (attenuation applies to minting, `docs/12`).
26. **How are new capability types introduced without kernel changes?** New manifests are just
    data; genuinely new *interaction shapes* arrive via the Kind registry and governed
    extensions with conformance gates — the CRD move (`docs/12`).
27. **What are the minimal kernel primitives?** The nine objects + two mechanisms of `docs/05`;
    every one passed the six-question admission test and the removal test.
28. **What concepts should explicitly NOT be kernel primitives?** Agent, Harness, Graph, Loop,
    Planner, Workflow, Prompt, Message-array, Tool-as-type, Model, Provider, Memory tiers,
    Supervisor, roles/teams, distributed transport (`docs/05` rejected-primitives section).
29. **What is the smallest MVP that tests the architecture?** `docs/14`: single-node TS kernel,
    four model adapters (incl. Gemini and OpenAI-compat), shell/HTTP/MCP/human capabilities
    with the sandboxed enforcement floor, two harnesses, graph + loop strategies, commit-gate
    verification, checkpoint/kill-9/resume, eight falsifiable claims F1–F8 with explicit
    failure conditions.
30. **Is there enough differentiation to justify building rather than extending?** Yes, with
    the retraction noted in §1: the surviving discriminators are the negotiation layer
    (homeless in incumbents), the clean-slate record format, governance freedom, and — once
    the enforcement floor and isolation land — kernel-invariant enforcement. EXTEND is the
    documented, triggered fallback, and the unanimous external vote was BUILD WITH CHANGES.

## 7. MVP, waves, risks, next step

**MVP** (`docs/14`): proves or disproves, via eight falsifiable claims, that heterogeneous AI
execution mechanisms operate through the same minimal primitives without losing their unique
capabilities — universality without type-dispatch, harness independence, orchestration
coexistence, open/closed parity, loud negotiation, kill-9 durability, enforced grants (against
a deliberately malicious strategy, per A6), MCP/A2A projection. Each claim has a stated
observation that would falsify it and trigger the documented fallback.

**Waves** (`docs/15`, canonical numbering): 0 — schema + facade freeze, property-test gate,
governance workstream; 1 — kernel core with crash-resume fuzzing; 2 — capability tier (four
adapters, tools with the enforcement floor, probe suite, manifest catalog for the four);
3 — strategy tier and the benchmark matrix with the selection contract; 4 — hardening (taint
end-to-end, redaction, chaos tests, crossing-cost measurements); 5 — ecosystem (Python SDK,
A2A projection, WASM isolation spike, self-hosting dogfood). Kubernetes is required nowhere;
`kyxo run objective.yaml` is the north star for the simple case, and the default profile is
concretely designed, not implied (`docs/14`).

**Top risks** (register in `docs/15`): differentiation half-life vs MCP/A2A/provider
absorption (leading indicator: remote-domain event share); curation economics of the manifest
catalog (scoped by A14); DX complexity (C4 — mitigated by the frozen facade, the default
profile, and the minimal tool-author path); crossing-cost when isolation lands (measured gate,
EXTEND fallback); governance execution (Wave-0 workstream with kill signal).

**The exact next engineering step:** implement Wave 0's first artifact — the executable
property-test specification of journal/checkpoint/fork/dedup semantics (A1) over the existing
prototype kernel, because it is the one place a reviewer showed the current design could be
incoherent, it blocks the record-format freeze that everything else depends on, and it has an
explicit reopen clause if it fails.

## 8. Conclusion

Should this exist? **Yes — as the layer beneath agent frameworks, not as another one of
them.** The research found the ecosystem already converging on this kernel's shape four
separate times without naming it; the gap map it would own is real, evidenced by absence, and
worth owning; the prototypes showed the central abstraction holds without special-casing; and
ten adversarial reviewers, asked to kill it, unanimously concluded it should be built — with
the changes now bound into the spine. The mission's design principle survives intact and is
the program's best one-line summary: **we do not predict what comes after agents; we ship the
extension boundary that makes predicting it unnecessary.**
