# ADR-006: Model Adapters Are Code-Bearing Plugins with Behavior Profiles and Opaque Carry-Through

> **Post-review status (2026-08-16).** This document predates the adversarial review; the review's
> binding adjudications live in the Amendment log of `research/DESIGN-SPINE.md` (A1–A14), with the
> full findings in `research/ADVERSARIAL-REVIEW.md`.
> **Applied here:** none. **Adopted but not yet reflected in this document's body:** A3, A9(ii). Where this document conflicts with the Amendment log, **the amendment log governs**; reconciling this body text is tracked as remaining editorial work.


- **Status:** Proposed (pre-adversarial-review)
- **Date:** 2026-08-16
- **Spine anchor:** `research/DESIGN-SPINE.md` §1 (H4, C2), §2 (vocabulary: *Model*, *Model API*, *Model adapter*), §4 (escape hatch)
- **Related:** 06-CAPABILITY-SPEC, 03-HARNESS-COMPARISON, 12-EXTENSION-MODEL

## Context

The model adapter is the boundary object between the kernel's typed world and the divergent wire world of model APIs. What an adapter *is* — a config record mapping field names, or a code-bearing plugin with executable duties — determines whether Kyxo survives contact with the actual heterogeneity of the model ecosystem.

**Force 1 — in the open-model world, the model boundary is not a line but a band, and the band is full of code.** FACT: for open models, the harness↔model contract is a Jinja chat template *shipped with the weights* and executed at request time; templates differ per family, and Ollama uses an entirely different template language (Go `text/template`) for the same job. Tool calling is a three-layer construct — schema-level contract, template rendering tools into the prompt, and a *parser* lifting model tokens back into structured calls — and layers two and three are per-model-family plugins in every serving engine: vLLM ships ~25 named tool-call parsers plus a `--tool-parser-plugin` runtime registration interface with both complete and streaming extraction methods; SGLang ships 13; llama.cpp ships per-family handlers with a grammar-constrained generic fallback. Reasoning traces need their own named parsers (`--reasoning-parser`). INFERENCE (HIGH): "model" in an open ecosystem is weights + tokenizer + template + output parsers — a bundle with code on both the encode and decode edges (research/notes/open-model-infrastructure.md).

**Force 2 — provider state must be carried through opaquely, or requests fail loudly.** The evidence is uniform across closed providers: OpenAI reasoning items must be preserved between function calls (server-side state or an `encrypted_content` blob the client round-trips — keeping them raised cache utilization from 40% to 80% and measurably improved benchmark scores, FACT via cookbook); Anthropic thinking blocks carry a `signature` that must be echoed **unchanged** or the API rejects the request; Gemini 3 *enforces* thought signatures with a documented 400 for a missing signature on the first functionCall part; DeepSeek's hosted API 400s when OpenAI-compatible clients strip `reasoning_content` (OBSERVED BEHAVIOR/HIGH across four issue trackers). INFERENCE (HIGH): these are one kernel requirement — persist and replay provider-opaque state bound to (provider, model, conversation position), never let generic history sanitizers strip it, and know it is non-portable across models (research/notes/open-model-infrastructure.md).

**Force 3 — inheriting a provider shape into the runtime is a documented failure.** SOURCE-CODE OBSERVATION (HIGH): ADK's `Event` extends `LlmResponse` and its interlingua is Gemini's GenerateContent schema — the provider shape leaks into the persistence layer and every event consumer, and the 2.0 schema additions broke downstream stores and validators. The note's own conclusion: a universal kernel must define its own content/tool-call normal form and treat provider schemas as adapter concerns, "otherwise 'model-independent' is one inheritance edge away from false" (research/notes/google-adk.md).

**Force 4 — per-model behavior is real, measured, and patched today by hand.** FACT: Claude Code's system prompt carries model-conditional lines compensating for Opus 5's delegation eagerness; termination judgment is model-behavioral; effort semantics are model-level knobs; the note concludes a universal kernel "needs a per-model *behavior profile* (prompt fragments, caps, defaults) as part of its model-adapter contract — the one component this stack conspicuously lacks" (research/notes/anthropic-claude-code-agent-sdk.md). SOURCE-CODE OBSERVATION (HIGH): Aider binds edit formats per model in its catalog; Copilot's EditToolLearningService measures per-model edit-tool success and adapts the exposed toolset (research/notes/coding-agents-landscape.md).

**Force 5 — the LCD "universal model API" is empirically fatal, and both major dialects are lossy moving targets.** The 16-axis divergence catalog (research/notes/open-model-infrastructure.md §10) shows every headline capability decomposing into independently-varying sub-axes; "OpenAI-compatible" is a family of drifting subsets with no conformance suite and divergent unknown-field behavior; third-party reimplementations of both major dialects are documented as lossy (Ollama's Anthropic layer: thinking budget not enforced, no `tool_choice`, no caching). The note's implication #9: internal representation should be a *superset* event/block model with dialect adapters at the edge.

## Decision

**Model adapters in Kyxo SHALL be code-bearing plugins — not config records — with five mandatory elements:**

1. **Encode/decode duties as code.** An adapter implements `encode(compiled context, tool bindings) → wire request` and `decode(wire stream) → typed kernel events`, including incremental/streaming decode. Templates, tool-call parsers, and reasoning parsers are adapter internals, versioned with the adapter — mirroring what vLLM/SGLang/llama.cpp already made pluggable at the serving layer.
2. **Axis-typed manifest.** Each adapter declares its position on the model-facing axes (statefulness, reasoning visibility/replay/budget, tool emission/result dialects, streaming grammar, structured-output expressivity with the actual schema subset as data, caching contract, sampling surface, modality/task types, error semantics for unknowns, …) per ADR-003. Both invocation shapes are first-class: request/response-with-streaming AND bidirectional session (Realtime/Live cannot be lowered onto function calls — FACT/HIGH, research/DESIGN-SPINE.md §4); non-chat task shapes (embed, rerank, classify, apply, transcribe) are declared invocation profiles, not chat impersonations.
3. **Behavior profile.** A versioned, data-carried profile per model (or model version): prompt fragments and patches (the Claude-Code model-conditional-line pattern made explicit), termination/delegation tendencies the harness should compensate for, recommended caps and defaults, and preferred dialects (edit format, tool naming). Profiles are inputs to harness×model pairing (ADR-005) and are updatable from outcome telemetry without code changes.
4. **Opaque carry-through artifacts.** Provider state the harness must not touch (reasoning items, thinking/thought signatures, echo-required fields, session resumption handles) is captured as typed, provenance-labeled opaque Artifacts bound to (provider, model, position). The kernel guarantees: carried through replay verbatim, never silently stripped by context compilation or compaction, never replayed across a different (provider, model) without an explicit, policy-visible conversion or drop decision.
5. **Superset internal block model + typed passthrough.** The kernel's internal normal form is its own versioned discriminated union of content blocks and stream events — a superset of the provider dialects, never inheriting from any provider type. Features outside the axis vocabulary flow through a **typed provider-native passthrough**: declared in the manifest, policy-visible, provenance-labeled, never silently dropped (the `extra_body` pattern made honest). A binding that requires an axis the adapter lacks fails loudly at bind time (ADR-003).

## Alternatives considered

**A. Universal model API (LCD normalization).** One canonical request/response shape; adapters merely rename fields; unsupported features are dropped or approximated. Rejected on the full weight of the 16-axis evidence: LCD flattening produces hard 400s (Gemini signatures, DeepSeek reasoning, Anthropic tampering), silent capability loss (dropped `tool_choice`; Chat Completions dropping reasoning with measured quality regression), and silent cost regressions (cache-contract mismatch) (research/notes/open-model-infrastructure.md, FACT/OBSERVED BEHAVIOR/HIGH). The LCD keeps the intersection of structured-output tiers and destroys the CFG/regex/structural-tag tier that agentic pipelines use for non-JSON DSLs and typed edits. Routers that took this path are the documented cautionary landscape, not prior art to copy.

**B. Config-only adapters.** Adapters as declarative records (endpoint, auth, field mappings) with shared generic encode/decode. Rejected: the duties are demonstrably executable code — two incompatible template *languages*, ~40 named streaming parsers across two serving engines, signature capture and replay logic, incremental JSON repair, era/dialect detection. Every serving engine that faced this problem made the adapter a code plugin (`--tool-parser-plugin`, `--reasoning-parser`, `--chat-template`); a config grammar rich enough to express these duties *is* a programming language, poorly. Config-only also cannot express behavior profiles' interaction with harness callbacks (prompt patches are content, not mapping).

**C. Standardize internally on one provider dialect (OpenAI Responses or Anthropic Messages as the kernel's normal form).** Rejected: this is ADK's Gemini coupling with a different logo — the provider shape would leak into the journal, the Kind schemas, and every consumer, and the chosen dialect is itself a moving, subsetted, third-party-reimplemented target (research/notes/google-adk.md; research/notes/open-model-infrastructure.md §6). Both major dialects are projections Kyxo must *emit at the edges*, which is only possible if the internal model is a superset of both.

## Consequences

**Positive:**

- Model heterogeneity is absorbed at one versioned boundary: harnesses and strategies program against typed kernel events; providers can pivot (as MCP did, as Responses did) without kernel changes.
- The opaque carry-through channel converts today's most common cross-provider breakage class (stripped provider state → 400s / silent quality loss) into a structural impossibility, and makes the non-portability of provider state *visible* to policy instead of discovered in production.
- Behavior profiles turn per-model tribal knowledge (prompt patches, delegation drift, dialect preferences) into versioned, telemetry-updatable data — the missing component the Claude stack's own analysis names.
- Non-chat task shapes and session-shaped invocations are first-class, so embedding/rerank/apply pipelines and Realtime/Live sessions bind through the same contract instead of chat impersonations.

**Negative (real costs):**

- **Code-bearing plugins are an isolation and trust surface.** An adapter executes on the request path with access to compiled context; a malicious or buggy adapter can exfiltrate or corrupt. V1 runs adapters in-process (spine §8 defers isolation), so the mitigation is provenance labels + policy visibility + review, not containment — an honest gap until WASM/process isolation lands. This is the single most uncomfortable consequence of this ADR.
- **A permanent maintenance treadmill.** Parser/template breakage across model-family revisions is documented (DeepSeek v3→v3.1→v3.2 each needing a new parser); adapters and behavior profiles decay at provider-release speed, and probe suites (ADR-003) must catch the decay. This is headcount, forever.
- **The superset block model lags the frontier by design.** A brand-new provider construct exists first only in passthrough; until the axis vocabulary absorbs it, the ecosystem sees two-speed semantics (typed core vs. passthrough), and strategies written against passthrough are provider-locked in exactly the way the kernel exists to prevent. The graduation pipeline (experimental → extension → core axis) is the mitigation and its latency is the cost.
- **Behavior profiles encode decaying empirical claims.** A profile tuned for Opus 5's delegation drift is misinformation for Opus 6; stale profiles silently mis-tune harnesses. Profiles need the same freshness discipline as probes, and unlike probes they cannot be mechanically re-derived.
- **Superset envelope versioning is a forever-contract** shared with ADR-002's journal: every new block/stream-event kind is a schema evolution event with conversion obligations, slower than any single vendor iterating its own private shape.

## Evidence & confidence

```
Evidence      — Model-shipped templates in two languages; ~25+13 named tool parsers with plugin
                registration; reasoning parsers; three-layer tool-call construct; 16-axis
                divergence; extra_body confession; loud-vs-silent unknown-field asymmetry;
                superset-model recommendation (FACT / SOURCE-CODE OBSERVATION / OBSERVED
                BEHAVIOR / INFERENCE-HIGH, research/notes/open-model-infrastructure.md).
                Echo-required provider state across four providers with documented 400s and a
                measured 40%→80% cache-utilization delta (FACT + OBSERVED BEHAVIOR/HIGH, same
                note). Event-extends-LlmResponse coupling failure (SOURCE-CODE OBSERVATION/HIGH,
                research/notes/google-adk.md). Model-conditional prompt patches, behavior-profile
                gap named (FACT, research/notes/anthropic-claude-code-agent-sdk.md). Per-model
                edit formats and learned edit-tool selection (SOURCE-CODE OBSERVATION/HIGH,
                research/notes/coding-agents-landscape.md).
Interpretation— The adapter's duties are executable, per-family, and drifting; provider state is
                load-bearing and opaque; provider shapes must terminate at the adapter. Every
                serving engine and every serious harness already implements fragments of this
                design; none composes all five elements.
Implication   — Kyxo's adapter contract = code plugin (encode/decode) + axis manifest + behavior
                profile + opaque carry-through artifacts + superset internal model with typed
                passthrough; both request/response and session invocation shapes first-class.
Confidence    — HIGH on all five elements individually (each is directly evidence-forced).
                MEDIUM on the in-process trust posture for V1 — flagged as the top security
                concern for the adversarial review and the WASM-isolation wave.
```
