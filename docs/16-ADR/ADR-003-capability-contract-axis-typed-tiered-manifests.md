# ADR-003: Capability Contract — Axis-Typed Tiered Manifests with Three Information Sources

- **Status:** Proposed (pre-adversarial-review)
- **Date:** 2026-08-16
- **Spine anchor:** `research/DESIGN-SPINE.md` §1 (H2, H4, C3), §4 (capability contract)
- **Related:** 06-CAPABILITY-SPEC, 05-KERNEL-PRIMITIVES (Binding), 12-EXTENSION-MODEL

## Context

Everything northbound and southbound of the Kyxo kernel is a capability with a manifest: model adapters, tools, MCP servers, harnesses, graph strategies, verifiers, humans, execution environments, remote runtimes. Capability negotiation computes a Binding from a manifest plus requirements. The contract's grammar is therefore the single most consequential schema in the system. The forces:

**Force 1 — boolean feature flags are empirically inadequate.** The model-facing evidence alone enumerates **16 axes of divergence** — statefulness, prompt encoding level, reasoning visibility, reasoning replay contract, reasoning budget control, tool-call emission format, tool-result re-encoding, streaming grammar, transport/session model, structured-output expressivity, caching contract, sampling surface, modality/task type, resource lifecycle, capability discovery, error semantics — each with 2–5 mutually incompatible paradigms rather than yes/no answers (research/notes/open-model-infrastructure.md). "Supports reasoning" decomposes into visibility (raw / separate field / summarized / hidden / absent) × replay contract (must-echo-or-400 / must-carry-opaque-blob / dropped-server-side / none) × budget control (token budget / discrete level / effort / boolean / none). INFERENCE (HIGH): any two providers differ on at least one sub-axis, and several fail *loudly*: stripping unknown fields is correct behavior on one provider and a hard 400 on another (DeepSeek `reasoning_content`, Gemini thought signatures — OBSERVED BEHAVIOR/HIGH and FACT respectively).

**Force 2 — a proven grammar exists and survived a rewrite.** FACT: MCP's capability grammar has three tiers — named typed capabilities (presence = support, nested sub-feature objects), an `experimental` free-form bag, and a governed `extensions` namespace (reverse-DNS identifiers → settings objects; "empty object = supported, no settings"; documented-fallback rule; 12-month deprecation clocks). This grammar survived the 2026-07-28 stateless pivot — the protocol replaced its own lifecycle model *using* its versioning model (research/notes/mcp-protocol.md). It is the most complete capability-contract design in the ecosystem, and it is deliberately *not* authority: capabilities are feature-support declarations, with authority carried separately (OAuth there; Grants here).

**Force 3 — declared capability ≠ competence (spine C3).** SOURCE-CODE OBSERVATION (HIGH): GitHub Copilot's `EditToolLearningService` maintains, per model, a windowed success bitset per edit tool and answers `getPreferredEditTool(model)` — the harness *measures* which patch dialect each model applies reliably and adapts the exposed toolset. Aider binds edit formats per model in its model catalog for the same reason (research/notes/coding-agents-landscape.md). Declarations alone would have routed identically to a tool the model fumbles 40% of the time.

**Force 4 — nothing negotiates today, and the informal ceiling is visible.** `/v1/models` returns IDs, not capabilities; clients hardcode (research/notes/open-model-infrastructure.md). SOURCE-CODE OBSERVATION (HIGH): MAF's answer is structural typing — `@runtime_checkable` protocols (`SupportsShellTool`, `SupportsMCPTool`, …) checked by `isinstance` — real but informal, unversioned, non-negotiable, in-process-only (research/notes/microsoft-autogen-sk-agent-framework.md). Cline's fail-closed provider operation manifests (image-gen/transcription fail unless declared) are the strongest declaration-based practice found in a shipped product (research/notes/coding-agents-landscape.md).

**Force 5 — advisory metadata must not masquerade as enforcement.** FACT: MCP tool annotations (`readOnlyHint`, `destructiveHint`) are normatively *untrusted* hints; roots are "always informational, never enforced" (research/notes/mcp-protocol.md). Claude Code's docs draw the same line between "context, not enforced configuration" and client-enforced settings (research/notes/anthropic-claude-code-agent-sdk.md). A contract that cannot say which of its claims are enforced invites policy built on hints.

**Force 6 — silent degradation is the documented anti-pattern.** LCD flattening produces hard 400s (Gemini signatures, DeepSeek reasoning), silent capability loss (Ollama's OpenAI-compat layer dropping `tool_choice`), and silent quality/cost regressions (Chat Completions dropping reasoning items — measurably worse results per OpenAI's own cookbook; cache-contract mismatches) (research/notes/open-model-infrastructure.md). The `extra_body` escape hatch is "the ecosystem's confession that the standard is insufficient" — untyped, undiscovered, unvalidated.

## Decision

**Capability manifests SHALL be axis-typed and tiered; Bindings SHALL be computed from three information sources; mismatches SHALL fail loudly at bind time.**

1. **Axis-typed, tiered axes — never booleans.** A manifest declares typed, named capability axes whose values are *tiers within the axis* (e.g., structured-output expressivity: `cfg > regex > json-schema-subset(S) > json-mode > none`, with the provider's actual schema subset carried as data). The 16-axis list from research/notes/open-model-infrastructure.md is the normative starting axis vocabulary for model-facing capabilities; non-model capabilities use the same grammar with different axes (doc 06 carries the registry).
2. **Three-tier grammar (MCP-proven).** (a) *Named typed axes* — governed, versioned, the portable core; (b) *`experimental`* — free-form namespace for pre-standard axes; (c) *governed reverse-DNS extensions* — `vendor.domain/name` identifiers with settings objects, independent evolution, documented fallback behavior, and stability classes (experimental/testing/stable/deprecated with a 12-month deprecation floor, per MCP's lifecycle).
3. **Three information sources, with distinct roles.**
   - **Declared** manifest: what the capability claims. Gates *eligibility* — a Binding cannot include an undeclared axis.
   - **Probed** results: what the kernel (or registry) verified by running first-class `probe` invocations; probe outputs are cacheable Evidence artifacts with timestamps and target version pins.
   - **Observed** outcome telemetry: what actually worked, recorded per capability×consumer pair (the Copilot EditToolLearningService pattern generalized). Drives *selection* among eligible bindings and feeds back into routing.
   Declarations gate eligibility; telemetry drives selection; probes arbitrate when they disagree.
4. **Enforced vs. advisory is explicit per claim.** Every manifest entry carries an enforcement class: `enforced` (the kernel or provider structurally guarantees it — e.g., a sandbox's filesystem scope) or `advisory` (a hint — e.g., `readOnlyHint`). The policy pipeline MAY bind only to `enforced` claims; binding deny-class policy to advisory claims is a bind-time error.
5. **Fail-loud binding.** Negotiation intersects two-sided declared feature sets (requirements × manifest), chooses dialects/tiers, and seals a typed Binding. If a *required* axis or tier is absent, binding **fails at bind time** with a typed error naming the missing axis — the kernel never silently degrades, drops fields, or downgrades tiers. Optional axes degrade only through the declared fallback documented for that axis. Unknown-must-ignore applies to unknown *extensions*; unsolicited use of an un-negotiated feature is an error (TLS-shaped); GREASE values are injected from v0 to keep intersection code honest.
6. **Typed passthrough, never silent.** Provider-native features outside the axis vocabulary flow through the manifest-declared, policy-visible, provenance-labeled passthrough channel (the `extra_body` pattern made honest — see ADR-006); undeclared passthrough is rejected.

## Alternatives considered

**A. Boolean feature flags / simple capability lists.** `{tools: true, reasoning: true, streaming: true}`. Rejected: the H4 refinement exists precisely because this fails — every headline feature decomposes into independent sub-axes with incompatible paradigms, and boolean intersection either blocks valid pairings (too coarse) or permits fatal ones (a "reasoning: true" match between a must-echo provider and a strip-unknown-fields consumer is a guaranteed 400) (research/notes/open-model-infrastructure.md §5, §10). MCP itself outgrew pure booleans into nested typed objects plus extensions.

**B. Structural typing at the code level (MAF position).** Capability = implementing an interface; discovery = `isinstance`. Rejected: informal, unversioned, unnegotiable, and confined to one process and one language — it cannot cross the wire to remote capabilities, cannot express tiers ("supports structured output" cannot say *which schema subset*), cannot be probed or carry telemetry, and cannot distinguish enforced from advisory. MAF got "surprisingly far without negotiation" (research/notes/microsoft-autogen-sk-agent-framework.md) — inside one runtime, with one vendor's curated adapters. Kyxo's capability surface is heterogeneous and remote by design; the informal ceiling is below our floor.

**C. Declared-manifest-only (no probes, no telemetry).** A clean spec-only contract. Rejected by C3: declaration ≠ competence. Manifests drift from reality (tool-call parser breakage across DeepSeek v3→v3.1→v3.2 checkpoint revisions is a documented churn case — research/notes/open-model-infrastructure.md), vendors over-claim, and competence is *pairwise* (a capability competent under one model is fumbled by another — the entire Aider/Copilot evidence line). Without telemetry the router cannot learn; without probes the registry cannot audit. The cost of three sources is real (see Consequences) but the two extra sources are the difference between a capability *catalog* and a capability *contract*.

**D. Negotiate nothing; fail at invocation time.** Skip bind-time intersection; let invocations error naturally. Rejected: this is the status quo the evidence indicts — failures surface deep inside runs as provider 400s, silent quality loss, or cost regressions, after budget has been spent and state committed. Bind-time sealing is also where Grants and policy routes attach (spine object 2); without a sealed Binding there is no stable object to attenuate or audit.

## Consequences

**Positive:**

- Routing can be *correct by construction*: a plan requiring signature-preserving reasoning replay simply cannot bind to a target that strips it; the failure is a named, actionable bind error instead of a mid-run 400.
- The manifest + probe suite for top targets is standalone early value, independent of kernel adoption — "nobody negotiates today; clients hardcode" is an open niche (research/notes/open-model-infrastructure.md #10; research/DESIGN-SPINE.md §10).
- Enforced-vs-advisory gives the policy/security layer a sound foundation: deny-class policy binds only to structural guarantees, ending the industry practice of building safety on untrusted hints.
- The three-tier grammar gives the ecosystem an evolution path (experimental → extension → core axis) proven by MCP's own survival of a breaking rewrite.

**Negative (real costs):**

- **Axis vocabulary governance is a standing institution, not a schema.** Someone must own admission, deprecation, and tier ordering for axes; get it wrong and the vocabulary either balloons (every vendor quirk an axis) or ossifies (new paradigms squat in `experimental` forever). This is the same governance burden MCP carries with SEPs and working groups — budgeted, permanent work.
- **Manifest authoring is a real barrier for capability publishers.** A tool author who today writes a JSON-schema function signature must now classify axes and enforcement classes. Defaults and generators mitigate; the burden remains and will suppress long-tail capability publication relative to "just an OpenAPI spec."
- **Probe suites decay.** Providers ship silently; probes pinned to last month's behavior go stale, and a wrong-but-cached probe result is worse than no probe. Probe freshness policy and re-validation scheduling are operational costs forever.
- **Telemetry raises tenancy and privacy questions the contract itself cannot answer.** Outcome telemetry per capability×consumer pair is operationally sensitive (it encodes what your agents do and how well); aggregation boundaries, retention, and sharing must be settled in the policy layer (doc 11), and cross-org telemetry pooling — the thing that would make selection data actually rich — may be unachievable.
- **Fail-loud surfaces friction that LCD shims hide.** Users migrating from LiteLLM-style routers will experience bind failures where they previously experienced silent degradation; some will read this as Kyxo being "more broken." Documentation and high-quality bind-error remediation hints are load-bearing for adoption.

## Evidence & confidence

```
Evidence      — 16-axis divergence catalog with loud/silent failure modes; extra_body as
                confession; discovery near-absent (FACT/OBSERVED BEHAVIOR/INFERENCE-HIGH,
                research/notes/open-model-infrastructure.md). MCP three-tier grammar, per-request
                declaration, typed mismatch errors, extension lifecycle, 12-month deprecation
                floor, annotations-as-untrusted (FACT, research/notes/mcp-protocol.md).
                EditToolLearningService per-model success bitsets; Aider per-model edit formats;
                Cline fail-closed operation manifests (SOURCE-CODE OBSERVATION/HIGH,
                research/notes/coding-agents-landscape.md). MAF structural-typing ceiling
                (SOURCE-CODE OBSERVATION/HIGH, research/notes/microsoft-autogen-sk-agent-
                framework.md). PydanticAI capabilities as attachable bundles — nearest prior art
                for capability-as-contract, no negotiation (FACT, research/notes/agent-frameworks-
                crewai-pydantic-llamaindex-mastra-letta.md).
Interpretation— The ecosystem has independently produced every ingredient — tiered grammar (MCP),
                empirical selection (Copilot), fail-closed declaration (Cline), probe-style
                conformance (MCP governance) — but no system composes them, and none types the
                axes. The composition is the contract.
Implication   — Kyxo's Binding is computed from declared ∩ required, tier-selected, telemetry-
                ranked, probe-audited manifests, with enforcement classes and loud failure. Doc 06
                specifies the schema; the probe suite ships as standalone early value.
Confidence    — HIGH on axis-typing, tiering, and fail-loud (directly evidence-forced). MEDIUM on
                the three-source composition operating well at ecosystem scale — telemetry
                pooling and probe freshness are unvalidated operational bets flagged for the
                adversarial review.
```
