# ADR-024 — Effect claims are acquired at admission, inside a synchronous critical section

Status: **Accepted** (2026-08-16, Wave S1). Resolves blocker B1 (doc 22 §2, four
independent reviewers, FATAL). Amends ADR-002's recovery semantics by adding a claim
record to the journal; does not supersede it.

---

## 1. Context

The phase-2 format wrote an effect key to its index at **settlement** but read it at
**admission**, with an `await` in between. Two consequences, both reproduced:

- two concurrent invocations of the same key both passed the gate and both dispatched;
- an invocation that became `uncertain` left no claim at all, so a retry re-executed it.

For `external-irreversible` and `external-compensatable` effects, that is a double charge.

The deeper problem is that exclusivity was being derived from a record written *after* the
thing it was meant to prevent. A gate that closes once the horse has left is not a gate.

## 2. Decision

**An exclusive effect key MUST be claimed as a committed record before dispatch, and the
check-then-claim sequence MUST be one synchronous region containing no suspension point.**

Concretely:

1. `effect.claimed` is committed as part of the admission record, alongside
   `invocation.admitted`, `grant.reserved` and `invocation.dispatched`. One record, atomic.
2. Exclusivity is derived from the **declared effect class**, never from capability
   identity: `external-irreversible` and `external-compensatable` require exclusive
   possession. This preserves ADR-001 and the universality gate.
3. A claim in state `held`, `landed`, `uncertain` or `settled` blocks a competing
   invocation. In particular `uncertain` blocks, because an unknown outcome is not an
   absent one (ADR-019).
4. The critical section's atomicity is enforced, not documented:
   - a **static guard** in CI fails if `await`, `.then(` or `yield` appears in the region;
   - a **runtime re-entrancy guard** throws rather than admitting a second invocation.

## 3. What this does not claim

**Single writer per family.** The atomicity is in-process. Multi-writer exclusivity would
require storage-level compare-and-set, and is explicitly **not claimed**. The concurrency
contract is stated at the top of `s1-kernel.ts` so that a future distributed deployment
cannot inherit the guarantee by assumption.

**No in-flight dedup for non-exclusive classes.** Two concurrent invocations of the same
`external-idempotent` key both dispatch. Safe by declaration — idempotent means repeatable
— but it is a limit, and it is asserted rather than left to be discovered.

## 4. Alternatives considered

**Re-check after the await.** Rejected: it narrows the window rather than closing it. If a
suspension point exists between check and commit, the window between the re-check and the
commit is still a window. The property that makes the design correct is the absence of the
suspension point, so that is what is enforced.

**Optimistic claim with rollback.** Rejected: rollback of an external effect is
compensation, which is exactly what the irreversible class says is impossible.

**Lock per effect key.** Rejected as a kernel mechanism: it adds a primitive (a lock table
with lifetime and ownership semantics) to do what an ordering property already does.
Liedtke's test — does it *have* to be inside? — says no.

## 5. Consequences

**Positive.** Exclusivity is durable before the world can be touched; a crash between
admission and outcome leaves a claim that blocks retry; the refusal of a competitor is
itself a journaled record (`effect.claim.denied`), so contention is observable.

**Negative.** The admission path cannot perform async policy evaluation or async budget
lookup. Any future policy stage that needs I/O must run *before* admission and pass its
result in, or the region loses the property that makes B1 resolved. This is a real
constraint on the policy pipeline's evolution and is the main cost of this decision.

## 6. Evidence

`prototypes/kernel-semantics/tests/s1-concurrency.test.ts` — 13 tests: same-tick bursts at
2, 5, 20 and 100; mid-flight arrival against a signalling barrier; a competitor forced into
the middle of the admission region; post-crash uncertainty; the static no-await guard.

Every test asserts against a world counter rather than against journal state, because the
journal can look correct while the card is charged twice.

Confidence: **HIGH** for the single-writer case, **not claimed** for multi-writer.
