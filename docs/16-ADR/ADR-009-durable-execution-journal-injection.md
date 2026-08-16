# ADR-009: Durability by journal injection, not replay determinism

Status: **Proposed**

Deciders: Kyxo architecture program. Related: 08-EVENT-AND-STATE-MODEL, 07-RUNTIME-ARCHITECTURE, ADR-016 (portable checkpoints), ADR-014 (charge-at-commit).

## Context

The Kyxo kernel owns durable execution (spine §2: journal + checkpoint + resume semantics are kernel property, not middleware). The question this ADR settles is *which* durability mechanism: the three production durable-execution systems share one invariant but split into two recovery families, and the choice is load-bearing for everything downstream (repair verbs, versioning discipline, the portable record format).

**Evidence — the shared invariant.** FACT: Temporal, Restate, and DBOS all impose the identical contract — deterministic orchestration code, journaled/checkpointed nondeterministic effects, idempotent effect implementations — and none exempts AI; Temporal's docs explicitly name LLM invocations as things that must live in Activities (research/notes/durable-execution.md).

**Evidence — the two recovery families.** FACT: Temporal recovers by *re-emitting and positionally matching*: workflow code re-executes and each emitted Command is compared position-by-position against recorded Events; any mismatch is a non-determinism error. Restate recovers by *record-and-inject*: on recovery the handler re-executes and "whenever it encounters an action on the Restate context, it will skip execution and will inject the response it finds in the journal." DBOS recovers by *checkpoint lookup*: before each step, check for a checkpoint; if present, return it without executing (research/notes/durable-execution.md §§1, 3, 4).

**Evidence — the versioning ceremony of positional replay.** FACT: Temporal's `patched()` marker semantics require ~100 doc lines of edge cases (marker-position-vs-replay-position rules; absence of a marker poisons all future calls of that ID); the docs recommend periodic Continue-As-New *just to escape old code versions*; workflow code is "a versioned durable contract." FACT (the AI integrations): the upstream OpenAI `MemorySession` "is not replay safe"; Temporal's replacement dies at `continueAsNew`; serialized `RunState` "must define the same tool names, handoff graph, and MCP servers as the run that produced" it — the harness configuration itself becomes part of the durable contract; persisted payload schemas are "durable contracts across deployments" (research/notes/durable-execution.md §2).

**Evidence — history limits under AI payloads.** FACT: Event History terminates at 51,200 events / 50 MB (or >2,000 Updates, >10,000 Signals); per-payload cap 2 MB (base64 tax makes it ~1.5 MB effective for binary); token streaming through Signals means "a 30-second response generates roughly 150 publish Signals" and long streams *require* Continue-As-New carrying the entire in-memory log; External Storage (claim-check offload) was added pre-GA with "AI agent conversations" as a named motivating scenario (research/notes/durable-execution.md §§1–2).

**Evidence — the operational verbs agents actually need.** FACT: DBOS `forkWorkflow(workflowID, startStep)` reuses checkpoints up to a step and is pitched in its AI docs as *the* reproduction tool ("rerun the misbehaving step under the exact conditions," then re-test with a fixed prompt); DBOS's earlier time-travel debugger disappeared from current docs, superseded by fork-from-checkpoint. FACT: Restate 1.6 shipped pause/resume, restart-from-any-journal-point, and move-invocations-between-deployments as generic runtime verbs (research/notes/durable-execution.md §§3–4).

**Evidence — exactly-once is always a synthesis.** FACT: Restate ingress `Idempotency-Key` with 24 h retention; DBOS `deduplication_id`; Temporal Workflow Streams `(publisher_id, sequence)` dedup with a TTL that must exceed the retry window; Celery's early-vs-late ack with poison-pill escape. INFERENCE/HIGH: every queue system converges on lease/visibility-timeout + at-least-once redelivery + idempotent consumers; exactly-once is an engineered illusion, never a transport guarantee (research/notes/durable-execution.md §5).

**Interpretation.** INFERENCE/HIGH: every point of Temporal×AI friction traces to one root cause — Temporal assumes *code is the durable artifact and data flows through it*, whereas an agent workload's durable artifact is the conversation/event data, and the code (prompts, model choice, tool wiring) is the volatile part. In agent workloads the deterministic core shrinks to a trivial fold (append message, check tool calls, loop) while nearly everything interesting is an effect; positional matching buys failure detection that AI code — whose prompts change weekly — pays for in versioning ceremony (research/notes/durable-execution.md, Implications 1, 8).

## Decision

The Kyxo kernel is **journal-first (record-and-inject), not replay-first (re-emit-and-match)**:

1. **Record-and-inject recovery.** Every effectful invocation's outcome is appended to the typed, append-only Event journal (two-tier: references in the log, payloads as content-addressed Artifacts). On recovery, the kernel re-drives the cell and, at each invocation point, matches by **idempotency key** — not by history position — injecting the recorded outcome instead of re-executing. Code between journaled invocations is a projection over the journal, not a determinism contract enforced by positional comparison.

```mermaid
sequenceDiagram
    participant H as Harness (behaviour in a cell)
    participant K as Kyxo kernel
    participant J as Journal (Events) + CAS (Artifacts)
    participant C as Capability (model adapter, tool)

    H->>K: invoke(binding, args, idempotency key)
    K->>J: lookup(idempotency key)
    alt outcome journaled
        J-->>K: Event (outcome by Artifact reference)
        K-->>H: inject recorded outcome (no re-execution)
    else no record
        K->>C: execute under lease (visibility timeout)
        C-->>K: result
        K->>J: append Event + Artifact; decrement Grant at commit
        K-->>H: outcome
    end
```

2. **Idempotency keys on every invocation**, kernel-issued or caller-supplied, with documented dedup windows that survive log compaction (the Workflow Streams TTL-vs-retry-window coupling is a real correctness knob and gets a spec'd answer, not an implementation accident).

3. **Leases with visibility timeouts on every external effect.** At-least-once delivery + leases + idempotency keys + dedup = the exactly-once illusion, stated as such in the contract.

4. **Fork-from-checkpoint is the primary repair and upgrade verb.** A Checkpoint (journal position + state snapshot + pending invocations, bound to definition identity — spine §3.8) can be forked with amended definitions; recorded effects are reused up to the fork point. This subsumes Temporal Reset, DBOS fork, and Restate 1.6 journal restarts as one kernel verb.

5. **Version-by-data.** Every Event pins the config/prompt/model/strategy hashes under which it was produced. Old code paths are never required to survive in new binaries; there is no `patched()` equivalent. Upgrading is forking, not patching.

## Alternatives considered

**A. Temporal-style positional replay determinism.** Rejected. It is the strictest and richest failure-detection mechanism in the evidence — and that is precisely its cost profile: the determinism contract makes harness configuration (prompts, tool graphs, handoff wiring) part of the durable contract, which the Temporal AI-integration record shows breaking at exactly the points AI code changes weekly (`WorkflowSafeMemorySession`, RunState-tied-to-tool-graph, patching edge-case tables). The history limits (51,200 events / 2 MB payloads) are sized for command logs, not conversation logs, forcing Continue-As-New gymnastics and claim-check retrofits. We give up positional drift detection knowingly (see Consequences).

**B. No kernel durability — retry-from-scratch with idempotent top-level jobs.** Rejected. Agent runs wait on humans for days (Restate awakeables, DBOS `recv` with day-scale timeouts exist because of this), burn real money per model call, and need step-granular reproduction for debugging. Retry-from-scratch re-buys every token on every failure, cannot express typed suspension (`input-required`, `approval-required`, `budget-exceeded` — spine §3.3), and produces no audit record. Every production system studied converged on *some* durable record; the absence option has no surviving exemplar.

**C. Checkpoint-snapshots only, no journal (pure state transfer).** Seriously considered — Cursor ships state-transfer continuity commercially with no replay and no event sourcing (research/notes/cursor.md §8). Rejected as the *sole* mechanism: without a journal there is no step-granular fork, no audit trail, no charge-at-commit substrate, and no portable execution-record format (the gap map's item 5). Adopted instead as a complement: Checkpoints are first-class kernel objects and the migration primitive (ADR-016).

## Consequences

**Positive.**
- Prompts, model choices, and tool wiring change without nondeterminism errors or patch ceremony; the volatile part of AI systems is treated as volatile.
- The journal is simultaneously the recovery record, the audit log, the billing substrate (charge-at-commit, ADR-014), and the observability source (projections, spine §2).
- Fork-from-checkpoint gives the reproduction/repair workflow that both DBOS and Restate independently evolved toward, as one verb.
- A specified journal + checkpoint schema is publishable: "durable execution has no MCP-equivalent" (research/notes/durable-execution.md, Implication 10) — the record format becomes differentiation.

**Negative (real costs).**
- **Weaker corruption detection.** Positional matching catches orchestration-code drift that key-lookup matching silently tolerates: if a changed harness issues *different* invocations with colliding idempotency keys, we inject stale outcomes instead of failing loudly. Mitigation (key derivation includes definition hashes) narrows but does not close this; Temporal detects a class of bugs we will not.
- **The idempotency burden moves to capability authors.** Record-and-inject still requires effects to be idempotent under redelivery; the kernel can supply keys and leases but cannot make a non-idempotent tool safe. This is a permanent documentation/conformance load.
- **Dedup state is a correctness-critical, compaction-surviving data structure** with tunable windows; getting the TTL/retry coupling wrong loses exactly-once (the Workflow Streams evidence shows this failure is subtle).
- **Two-tier storage adds CAS lifecycle complexity** (garbage collection of unreferenced Artifacts vs journal retention) that single-store designs don't have.
- **The record format becomes a public contract** we must version forever, with upcasting discipline — the enduring unsolved cost of event sourcing per Fowler (research/notes/durable-execution.md §5).

## Evidence & confidence

| Claim | Label | Confidence | Source |
|---|---|---|---|
| All three durable systems impose deterministic-orchestration + journaled-effects + idempotency | FACT | — | research/notes/durable-execution.md §7 |
| Temporal recovery = positional command matching; limits 51,200 events / 2 MB payloads | FACT | — | research/notes/durable-execution.md §1 |
| Temporal×AI friction: RunState/session/patching ceremony | FACT | — | research/notes/durable-execution.md §2 |
| Restate record-and-inject; ingress idempotency keys, 24 h window | FACT | — | research/notes/durable-execution.md §3 |
| DBOS fork-from-step as repair verb; time-travel debugger superseded | FACT / OBSERVED BEHAVIOR | HIGH / MEDIUM | research/notes/durable-execution.md §4 |
| Root cause: code-as-durable-artifact vs data-as-durable-artifact inversion | INFERENCE | HIGH | research/notes/durable-execution.md §2 |
| Exactly-once is always at-least-once + dedup, never transport | INFERENCE | HIGH | research/notes/durable-execution.md §5 |
| Cursor ships state-transfer continuity with no replay | FACT (indirect retrieval) | HIGH | research/notes/cursor.md §8 |
| Journal-injection loses a class of drift detection positional replay catches | INFERENCE | MEDIUM | this ADR's own analysis; no production counter-evidence either way |

Decision confidence: **HIGH** on journal-first vs replay-first (convergent friction evidence); **MEDIUM** on the idempotency-key matching discipline (the drift-detection gap has no production-scale validation yet — flagged for the adversarial review).
