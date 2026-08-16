# ADR-010: TypeScript reference kernel, protocol-first, single-node V1

Status: **Proposed**

Deciders: Kyxo architecture program. Related: 14-MVP-ARCHITECTURE, 15-IMPLEMENTATION-ROADMAP, 12-EXTENSION-MODEL, ADR-016 (single-node scope).

## Context

The kernel hypothesis is validated (spine §1, H1); the remaining implementation question is language, packaging, and the relationship between specification and implementation. The evidence base supplies one strong positive precedent, one canonical failure mode, and one 30-year-old warning.

**Evidence — the protocol-extraction precedent and its failure mode.** SOURCE-CODE OBSERVATION/HIGH: Codex extracted its agent core behind an asynchronous Submission Queue / Event Queue protocol and an App Server JSON-RPC service so one harness powers CLI, IDE, desktop, and web — "one harness, many surfaces." Its documented weakness: schemas drift per CLI release; third-party clients pin binaries and regenerate types via `codex app-server generate-json-schema` — the protocol is emitted by the implementation rather than governing it (research/notes/openai-agents-sdk-codex.md §11, Implication 10). The same note records OpenAI implementing the same conceptual loop three separate times (Agents SDK, Codex, Responses API) with nothing but the wire API shared.

**Evidence — schema-versioned state formats decay when implementation-bound.** SOURCE-CODE OBSERVATION/HIGH: the Agents SDK's `RunState` carries `CURRENT_SCHEMA_VERSION` 1.15 (Python) vs 1.18 (JS) with explicit supported-version lists, excludes agent definitions, and needs invocation fingerprints bolted on for exactly-once resume — checkpointing retrofitted above a runtime, interpretable only by a narrow SDK version range (research/notes/openai-agents-sdk-codex.md §6).

**Evidence — the Mach lesson.** FACT: first-generation microkernels (Mach) had ~100 µs IPC, which killed the architecture's promise; L4 restored viability with order-of-magnitude faster IPC via radical minimality. INFERENCE/HIGH: Mach failed not because minimalism was wrong but because the primitive everything was forced through was slow — decomposition is viable only when the kernel's crossing primitive costs roughly nothing (research/notes/prior-art-negotiation-extension.md §9).

**Evidence — the isolation path.** FACT: the WASM Component Model targets "portable, virtualizable, statically-analyzable, capability-safe, language-agnostic interfaces"; WIT worlds make a component's total authority statically visible, and any import can be virtualized — the same move as ocap interposition (research/notes/prior-art-negotiation-extension.md §6). VS Code demonstrates the operational pattern: static manifests indexed without executing plugin code, lazy activation, out-of-process extension hosts (§11).

**Evidence — no in-kernel mesh needed for V1.** See ADR-016; distribution is deferred to portable checkpoints and protocol edges, so V1 needs no distributed consensus, only a conformance-tested storage interface (LangGraph publishes a checkpointer conformance suite and versions its checkpoint format with migrations — SOURCE-CODE OBSERVATION/HIGH, research/notes/langgraph.md).

## Decision

1. **The kernel API is a versioned schema first, an implementation second.** Events, manifests, invocation lifecycle states, checkpoint format, and the policy-stage interface are defined as a date-versioned protocol with stability classes (experimental/testing/stable/deprecated, 12-month deprecation floor — the MCP lifecycle discipline, spine §4). The reference implementation conforms to the spec; it does not generate it. This is the Codex SQ/EQ + App Server shape with the drift failure corrected: schema governs, conformance suite enforces.

2. **V1 reference implementation in TypeScript**, single-node (ADR-016), single-process execution semantics. Storage: SQLite/JSONL journal + file CAS behind a conformance-tested storage interface. The Python SDK follows as a client of the protocol, not a second kernel.

3. **In-process crossing is reference passing.** Capabilities hosted in-process exchange Artifact references (content addresses), never payload copies — zero-cost crossing, satisfying the Mach corollary trivially for V1.

4. **WASM component hosting is the isolation path**, not process-per-plugin: plugin capabilities (model adapters, tools, verifiers) compile to components whose imports the kernel virtualizes (policy interposition for free), with WIT-style typed worlds as the aspirational contract format (V1 manifests are JSON-schema-typed; spine §4).

5. **Rust is the designated replacement candidate post-validation.** Because userland binds to the versioned protocol, swapping the kernel implementation must not break any capability, harness, or SDK. Rewriting is a scheduled event, not a rescue.

6. **The honest performance caveat, stated as a gate:** the crossing-cost budget — context/artifact handoff across a process or WASM isolation boundary, at megabyte-scale payloads rather than L4's 64-byte messages — is currently **unmeasured**. No isolation wave (process hosts, WASM sandboxes) lands until that budget is measured against a monolithic in-process baseline. If crossing costs are Mach-like, the minimal-kernel architecture loses to monolithic frameworks on latency exactly as Mach lost to monolithic kernels, and the isolation roadmap must be redesigned around zero-copy shared CAS mappings before it ships. (research/notes/prior-art-negotiation-extension.md, open question 2, promoted here to a release gate.)

## Alternatives considered

**A. Rust-first.** Rejected for V1. The kernel's semantics (nine objects, closed invocation algebra, policy pipeline, journal format) are unvalidated; the cost of iterating on unvalidated semantics in Rust — where every representational change ripples through ownership and trait design — is paid at the highest possible interest rate. The evidence pattern is consistent: Codex went Rust *after* the loop semantics were proven in production TypeScript-era predecessors; Restate wrote its single Rust binary around already-known durable-execution semantics. Rust's payoff (predictable latency, no GC, memory safety at isolation boundaries) is real and is why it remains the designated successor; it buys nothing during semantic validation.

**B. Python-first.** Rejected. The kernel is scheduler-centric (cell turns, leases, cancellation propagation, deadline enforcement — spine §3); Python's concurrency story (GIL, colored async, weak structured cancellation) fights exactly that core. Protocol-first discipline also demands end-to-end static typing of the event/manifest schemas; TypeScript's structural typing over JSON-schema-derived types is the better fit. Python's ecosystem gravity is real but is served by the Python SDK against the protocol — the OpenAI Agents SDK's Python/JS divergence (RunState 1.15 vs 1.18 for the *same* concept) is what maintaining two first-class runtimes yields.

**C. Multi-language from day one.** Rejected. N implementations of unvalidated semantics is N× drift; the Codex per-release schema drift and the Py/JS RunState version skew are the documented outcome even *within* one vendor. Multi-language arrives as: one reference kernel + conformance suite + SDKs, then a second implementation (Rust) once the suite is authoritative.

## Consequences

**Positive.**
- Fastest possible iteration during the validation window; kernel semantics can change weekly without fighting a borrow checker.
- The versioned protocol makes the implementation replaceable (Rust later) and keeps userland stable across the swap — the property Codex demonstrably lacks.
- WASM component hosting aligns the isolation boundary with the ocap boundary (ADR-013): virtualized imports are interposition.
- SQLite/JSONL + file CAS keeps V1 operationally trivial (no server dependencies), while the conformance-tested storage interface keeps Postgres/object-store backends honest later (LangGraph precedent).

**Negative (real costs).**
- **A TypeScript kernel will lose raw benchmarks** against Rust incumbents (and against in-process monolithic frameworks) for scheduler-heavy workloads; GC pauses sit in the scheduling path. We are explicitly trading V1 performance for semantic iteration speed, and must say so rather than benchmark-dodge.
- **The reference implementation will exert gravity on the spec.** Every ambiguity in the schema will be resolved de facto by "what the TS kernel does" — the exact Codex disease. Only a maintained, adversarial conformance suite counteracts this, and conformance suites are chronic underinvestment targets.
- **The crossing-cost gate may fail.** If measured process/WASM crossing costs at context scale are prohibitive, the isolation roadmap (and with it part of the security story) must be rebuilt around shared-memory CAS mappings — a real architectural risk carried forward, not resolved by this ADR.
- **Node.js runtime coupling**: the kernel inherits Node's event-loop pathologies (long-task starvation) and its supply-chain surface; process-hardening equivalent to Codex's `process-hardening` crate does not come for free in the npm ecosystem.
- **Two artifacts to version forever**: the protocol schema *and* the implementation, with the protocol's stability guarantees (Linux regression constitution, research/notes/prior-art-negotiation-extension.md §15) binding us even where V1 behavior was accidental.

## Evidence & confidence

| Claim | Label | Confidence | Source |
|---|---|---|---|
| Codex App Server: one harness many surfaces; per-release schema drift | SOURCE-CODE OBSERVATION + OBSERVED BEHAVIOR | HIGH / MEDIUM-HIGH | research/notes/openai-agents-sdk-codex.md §11 |
| RunState schema skew Py 1.15 / JS 1.18; definitions excluded | SOURCE-CODE OBSERVATION | HIGH | research/notes/openai-agents-sdk-codex.md §6 |
| Mach ~100 µs IPC killed gen-1 microkernels; L4 order-of-magnitude fix | FACT | — | research/notes/prior-art-negotiation-extension.md §9 |
| Component Model: capability-safe, virtualizable typed worlds | FACT | — | research/notes/prior-art-negotiation-extension.md §6 |
| Checkpointer conformance suite + versioned checkpoint migrations | SOURCE-CODE OBSERVATION | HIGH | research/notes/langgraph.md |
| Crossing-cost budget at MB-scale payloads is unmeasured | INFERENCE (open question) | — | research/notes/prior-art-negotiation-extension.md open question 2 |

Decision confidence: **HIGH** on protocol-first and single-node; **MEDIUM** on TypeScript specifically (a defensible DX/typing judgment call, not a forced move — Go was not deeply evaluated and the adversarial review may reopen it); the crossing-cost gate is an acknowledged unresolved risk.
