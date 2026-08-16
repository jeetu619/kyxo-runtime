# 18 — Kernel Invariants

Status: **EXECUTABLE**, 2026-08-16.

> **EXTENDED by Wave S1 (2026-08-16).** Invariants I1–I25 below are checked by
> `prototypes/kernel-semantics/src/invariants.ts` against the phase-2 kernel and remain in
> force for it. The `2026-08-17` record format adds a second, independent set — **S1-I1 to
> S1-I12** in `src/s1-invariants.ts` — asserted after every crash, restart, fork and
> generated-sequence step:
>
> | Invariant | Statement |
> |---|---|
> | S1-I1 | At most one claim per effect key; a claim's exclusivity matches its class |
> | S1-I2 | Every landing has a claim — the world is never touched without a lease |
> | S1-I3 | Live state equals a fold of the journal, at **every committed prefix** |
> | S1-I4 | An exclusive effect key lands at most once per family |
> | S1-I5 | No grant is over-committed in any unit; no ledger figure is negative |
> | S1-I6 | A terminal invocation holds no reservation |
> | S1-I7 | Every landed exclusive key is reported as protected |
> | S1-I8 | Sequence numbers are dense and monotonic within each execution |
> | S1-I9 | The hash chain links, and each self hash recomputes |
> | S1-I10 | Every payload matches its committed hash, unless tombstoned |
> | S1-I11 | A grant chain is acyclic |
> | S1-I12 | Every invocation references a grant its family knows |
>
> S1-I3 is the load-bearing one and is I25 generalised: everything else can pass while live
> and replayed state quietly disagree, which is exactly how F-6, F-8 and F-9 survived.
>
> They are asserted against the **fold's output**, not against kernel internals, so the same
> checks apply to state the kernel built live and state an independent reader rebuilt from
> the journal. Every invariant below is either checked at runtime by
`prototypes/kernel-semantics/src/invariants.ts` (asserted after *every* operation in the
property and coverage suites), enforced structurally by the kernel's construction, or
enforced statically in CI. None is aspirational.

Format per invariant: **rationale** (why it exists), **enforcement** (what makes it
true), **test** (what would catch a regression), **failure mode** (what breaks if it is
violated).

The mission proposed twenty candidate invariants. Below, each is accepted, amended,
merged or rejected, with reasons. Five invariants (I21–I25) were added from executable
evidence — I25 came from adversarial review #2 and is the one that would have caught two
of this phase's worst defects.

---

## Accepted and enforced

### I1 — Kernel behaviour never branches on capability type or identity
- **Rationale.** The moment the kernel knows what an "agent" is, every future construct
  must be taught to the kernel. Traits (§11 of doc 17) carry mechanism without identity.
- **Enforcement.** Structural: the kernel resolves providers by id from a registry and
  reads only declared traits. Static: CI greps kernel and record-format sources for
  capability names and conceptual-type branching.
- **Test.** `universality.test.ts` — "the kernel source never branches on capability
  identity"; plus eight heterogeneous constructs through one path.
- **Failure mode.** New capability kinds require kernel releases; the extension boundary
  collapses.

### I2 — Provider identity does not change kernel semantics
- **Rationale.** Portability is meaningless if the kernel's lifecycle differs per vendor.
- **Enforcement.** Lifecycle, dedup, budgets and recovery derive from effect class and
  traits only.
- **Test.** `universality.test.ts` — heterogeneous capabilities survive checkpoint, fork
  and recovery identically.
- **Failure mode.** Provider-specific recovery paths, i.e. the thing this project exists
  to avoid.

### I3 — Userland cannot append authoritative committed events
- **Rationale.** If any participant can write truth, the journal is a log, not a ledger.
- **Enforcement.** Structural: providers hold no kernel reference (`InvokeCtx` is data);
  the commit path is private; drivers cause events only through kernel verbs.
- **Test.** `universality.test.ts` — malicious capability enumerates its context and
  finds no kernel surface.
- **Failure mode.** Fabricated history; audit worthless.

### I4 — Userland cannot bypass the commit barrier
- **Rationale.** A gate that a strategy can skip is a convention.
- **Enforcement.** Structural: proposals accumulate in a staging area the provider
  cannot address; promotion happens only after kernel validation.
- **Test.** `universality.test.ts` — a capability claiming success while proposing
  failing evidence lands `failed` with **zero** artifacts promoted.
- **Failure mode.** The phase-1 defect: "agent says done" becomes truth.

### I5 — A capability cannot expand its own grant
- **Rationale.** The definition of "the AI cannot grant itself privilege".
- **Enforcement.** Attenuation checks rights ⊆ parent and limits ≤ parent *remaining*;
  delegation is kernel-mediated and always attenuates.
- **Test.** `grants.test.ts` — attenuation refuses added rights and excess budget;
  delegation attenuation verified structurally.
- **Failure mode.** Privilege escalation through delegation depth.

### I6 — Committed journal records are immutable
- **Rationale.** Replay, audit and lineage all assume history does not move.
- **Enforcement.** Append-only storage; per-event hash chain (`prev`, `self`).
- **Test.** Runtime invariant check recomputes the chain for every execution after every
  operation.
- **Failure mode.** Undetectable tampering; replay divergence.

### I7 — Every committed event has causal lineage
- **Rationale.** An event you cannot attribute is not evidence.
- **Enforcement.** The kernel stamps `executionId`, `correlationId`, `actorId` at commit;
  writers cannot supply `actorId`.
- **Test.** Runtime invariant check.
- **Failure mode.** Unattributable spend and effects.

### I8 — Every artifact has provenance and exists in the CAS
- **Rationale.** Artifacts are the outputs people act on.
- **Enforcement.** `artifact.produced` carries `producedBy`; the kernel writes the blob
  before the event.
- **Test.** Runtime check; `dedup.test.ts` verifies per-producer provenance survives CAS
  dedup.
- **Failure mode.** Dangling references; first-writer-wins provenance lies.

### I9 — A checkpoint references a valid committed consistency boundary
- **Rationale.** A cut past uncommitted state is not a cut.
- **Enforcement.** `cutSeq` is the last committed seq; the checkpoint event itself is
  committed after it.
- **Test.** Runtime check (`cutSeq < own seq`); `crash.test.ts` verifies snapshot/journal
  agreement.
- **Failure mode.** Resume into a state that never existed.

### I10 — Resume does not rewrite committed history
- **Rationale.** Resume continues a lineage; rewriting it would erase evidence.
- **Enforcement.** Resume folds forward only; the journal has no update path.
- **Test.** Runtime differential check comparing per-execution history before and after
  every operation.
- **Failure mode.** Silent history loss.

### I11 — Fork does not mutate parent history
- **Rationale.** Branching must be free of side effects on the branched-from lineage.
- **Enforcement.** The child is a new execution with its own journal stream; the parent
  is never written during a fork.
- **Test.** `fork.test.ts` compares parent event ids before/after; property suite checks
  it after every operation.
- **Failure mode.** The audit trail of the original run becomes unreliable.

### I12 — Fork creates explicit new lineage
- **Rationale.** Implicit ancestry is unauditable ancestry.
- **Enforcement.** The child's first event is `execution.forked` with parent, checkpoint
  and cut.
- **Test.** Runtime check that every execution begins with a lineage-origin event.
- **Failure mode.** Orphan executions; provenance gaps.

### I13 — Replay does not silently repeat non-idempotent external effects
- **Rationale.** The costliest failure class in the entire system.
- **Enforcement.** Effect class triage on recovery; inherited unsafe effects refuse
  loudly across forks; protected-effect set survives in checkpoints.
- **Test.** `crash.test.ts` (world sees exactly one charge across crash + recovery);
  `fork.test.ts` (protected replay refused); runtime check for double completion of one
  effect key without an intervening dedup/fork/resolution record.
- **Failure mode.** Double charges, double sends, double deploys.

### I14 — Duplicate delivery cannot silently erase audit evidence
- **Rationale.** "It was deduped" must be observable; otherwise dedup hides incidents.
- **Enforcement.** Every suppression path commits a record before returning; CAS dedup
  is confined to storage.
- **Test.** `dedup.test.ts` — duplicate delivery journaled; identical content across
  executions yields two `artifact.produced` events with distinct provenance.
- **Failure mode.** The phase-1 defect: journal missing evidence that work occurred.

### I15 — Unknown external outcome is represented explicitly, never guessed
- **Rationale.** Distributed systems cannot always know; pretending otherwise is how
  money moves twice.
- **Enforcement.** `uncertain` state; dispositions required; a probe answering `unknown`
  keeps the state.
- **Test.** `crash.test.ts` (three tests, including the unknown-probe case).
- **Failure mode.** Guessed success (silent data loss) or guessed failure (double
  application).

### I16 — Crash recovery cannot convert an uncommitted candidate into a committed effect
- **Rationale.** Staging must not be a second, weaker journal.
- **Enforcement.** Staging is in-memory only and released on every exit path.
- **Test.** Runtime check that staging is empty after settlement; the property suite
  found a real leak here (doc 20 F-5).
- **Failure mode.** Effects appearing that no validation approved.

### I17 — A failed verification cannot be represented as successful completion
- **Rationale.** The commit gate is the difference between evidence and assertion.
- **Enforcement.** Evidence gate at settlement; the provider's own status cannot
  override it.
- **Test.** `universality.test.ts` (malicious capability); runtime check for completion
  despite failing evidence under a gate.
- **Failure mode.** Verification theatre.

### I18 — Grants cannot broaden through nested delegation
- **Rationale.** Depth must not launder authority.
- **Enforcement.** Every delegation attenuates from *current* parent state; rights and
  limits are checked at each hop.
- **Test.** `grants.test.ts` — delegation attenuation and both recursion-bound tests.
- **Failure mode.** A deep subagent with more authority than its root.

### I19 — Orchestration strategies cannot alter kernel semantics
- **Rationale.** Strategies are userland; if they can change lifecycle or accounting,
  the kernel is not a kernel.
- **Enforcement.** Strategies call verbs; they do not implement them. Loop/graph
  controls are configuration, not kernel paths.
- **Test.** Phase-1 prototypes (harness A/B, graph, loop) plus the property suite's
  driver-level operations.
- **Failure mode.** Per-strategy semantics; nothing is portable.

### I20 — Checkpoint restoration is deterministic with respect to committed state
- **Rationale.** A snapshot that disagrees with the log is a second source of truth.
- **Enforcement.** The snapshot is a fold of the prefix; resume re-folds and compares.
- **Test.** `crash.test.ts`, `universality.test.ts` — `consistent === true`.
- **Failure mode.** Divergent resume; unreproducible audits.

---

## Added from executable evidence

### I21 — Authority is object identity, not a string
- **Rationale.** If knowing an id grants power, every journal reader is an admin.
- **Enforcement.** Grant handles are objects the kernel minted and tracks in a private
  registry; journal references are non-resolvable identifiers.
- **Test.** `grants.test.ts` — three forgery attacks (construct with known id, prototype
  forgery, shallow copy) all rejected; the genuine handle still works.
- **Failure mode.** Authority leaks through logs, traces and error messages.
- **History.** This invariant was added because the first implementation exported its
  mint guard, making forgery trivial (doc 20 F-2).

### I22 — Every authority or policy refusal is journaled
- **Rationale.** A refusal that leaves no record is indistinguishable from work that was
  never attempted; incident review depends on the difference.
- **Enforcement.** Denial paths commit `grant.denied` / `policy.denied` before raising.
- **Test.** `grants.test.ts` (budget, revocation, expiry), `universality.test.ts`
  (deny-class policy), coverage guard requires ≥20 policy denials per run.
- **Failure mode.** Silent delegation failures — observed as F-3.

### I23 — Budget accounting is reserve-then-settle, never negative, never over-limit
- **Rationale.** Reservation before dispatch is what makes exhaustion detectable *before*
  spend; settlement at outcome is what keeps the ledger honest.
- **Enforcement.** Reservation is durable pre-dispatch; settlement and release move the
  same units; every ancestor is charged atomically.
- **Test.** Runtime check (`reserved + settled ≤ limits`, non-negative); differential
  test compares budgets against the reference model exactly.
- **Failure mode.** Overspend, or spend invisible to ancestors (the documented
  PydanticAI/Temporal leak).

### I24 — Effect identity is lineage-scoped and inheritance is marked
- **Rationale.** "Already done" means nothing without "by whom, and in which lineage".
- **Enforcement.** Fork inherits index entries at the cut, flagged `inherited`; unsafe
  inherited effects refuse rather than return cached success.
- **Test.** `fork.test.ts` (protected replay refusal, post-cut isolation); differential
  fork-isolation test across 21 seeds.
- **Failure mode.** F-1: a fork silently reports success for an irreversible effect it
  never performed.

### I25 — The journal is self-sufficient: live state equals recovered state
- **Rationale.** Any protection a kernel holds only in memory is a protection that lasts
  until the next restart. This invariant is the general form of two defects that reached
  production-shaped code before it existed (F-6, F-8).
- **Enforcement.** Every durable structure is rebuilt by folding committed records; forks
  materialize inherited authority, effect identity and protected effects into the child's
  own first commit rather than referencing a checkpoint blob.
- **Test.** `checkInvariants({deepRecoveryCheck: true})` recovers a shadow kernel from
  storage and compares cell state, protected effects, effect index and grants per
  execution. Asserted in `fork.test.ts`; sampled every seventh operation in the property
  suite (it is O(journal), so running it on every operation would dominate runtime).
- **Failure mode.** A fork or a restart silently loses protection, and an irreversible
  effect re-executes with **zero** other invariant violations reported — exactly what F-8
  did.
- **Scope caveat.** Meaningful only against the sole writer for a given storage. Two live
  kernels sharing one journal is not a supported configuration (there is no journal
  locking), and the stale one would legitimately differ.
- **History.** Added during adversarial review #2; it found F-9 within one run of being
  added.

---

## Amended, merged or rejected

| Candidate | Disposition | Reason |
|---|---|---|
| "Every committed event has causal lineage" | **Amended** (I7) | Strengthened: `actorId` must be kernel-stamped, not merely present. A forgeable actor field satisfies the letter and defeats the purpose. |
| "Replay does not silently repeat non-idempotent effects" | **Amended** (I13) | Extended to cover *inherited* effects across forks, not only replay within a lineage — the case that was actually broken. |
| "Grants cannot broaden unless re-issued by an authorized principal" | **Split** (I5, I18, I21) | Three distinct enforcement points (self-expansion, delegation depth, handle forgery) with three different failure modes; one invariant hid the forgery case. |
| "Checkpoint restoration is deterministic" | **Scoped** (I20) | Deterministic *with respect to committed runtime-owned state*. Provider-side session state and external resources are referenced, not owned, and cannot be guaranteed — saying otherwise would be false. |
| "Duplicate delivery cannot erase audit evidence" | **Generalized** (I14) | Applies to all six dedup mechanisms, not delivery alone; CAS dedup was the actual offender. |
| "Events cannot arrive out of order / more than once" | **Rejected as an invariant** | Category error, and a useful one to correct: events are *created* at commit, not delivered. Duplication and reordering are properties of deliveries and invocations (I14, I13). Stating it as an event invariant would imply a delivery pipeline the design does not have. |
| "Exactly-once execution" | **Rejected** | Not provideable in general (doc 17 §5.1). Claiming it would make every other guarantee suspect. |

---

## Coverage evidence

The runtime invariant set is asserted after every operation in the property and coverage
suites. Most recent full run:

| Measure | Value |
|---|---|
| Seeds | 150 (coverage) + 120 (property) + 1,000 (extended fuzz) |
| Operations | 4,500 (coverage) + 4,800 (property) + 70,000 (fuzz) |
| Invariant assertions | 4,500 + 4,800 (one full check per operation) |
| Violations found and fixed | 5 (see doc 20) |
| Violations outstanding | 0 |

The coverage guard fails the build if generated workloads stop reaching interesting
states, so a green suite cannot silently degenerate into a no-op.
