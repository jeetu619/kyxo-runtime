# 22 — Record-Format Freeze Decision

Date: 2026-08-16. Decision authority: this phase's mandate ("do not freeze merely because
tests pass once").

# Decision: **NOT READY TO FREEZE**

Unanimous across five specialist reviewers who were given the executable kernel, its
tests and the normative documents, and who wrote and ran their own attack scripts:
**17 FATAL, 34 SERIOUS, 9 MODERATE findings, of which 44 block the freeze.** Full record:
`research/ADVERSARIAL-REVIEW-2.md`.

This is the correct outcome, and it is what the phase was for. The alternative — freezing
a format that six independent attacks broke within hours — would have converted every one
of those defects into a permanent compatibility obligation.

---

## 1. Freeze criteria and current status

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Semantic specification complete | **PARTIAL** | Docs 17–19 exist and are normative, but reviewers found the spec makes claims the format cannot support (redaction without `payloadHash`; lease/epoch fencing declared but absent; taint declared in doc 11, absent in the kernel) |
| 2 | No unresolved FATAL issues in this area | **FAILED** | 17 FATAL findings, 8 of them with working reproductions |
| 3 | Property tests pass | **PASS** | 45 tests; 9,300+ invariant assertions per run |
| 4 | Deterministic model comparison passes | **PASS** | Differential agreement on outcomes, budgets, fork isolation |
| 5 | Crash matrix passes | **PARTIAL** | All 15 mission crash points covered, but reviewers showed `recover()` performs no integrity verification and silently skips mid-journal corruption |
| 6 | Fork tests pass | **PARTIAL** | 8 tests pass; reviewers found three further fork defects (grant ledger reset, revocation not crossing forks, protection scoped to the cut rather than the lineage tree) |
| 7 | Dedup tests pass | **PARTIAL** | 5 tests pass; reviewers showed the effect key is claimed at settlement rather than admission, so concurrent duplicates both proceed |
| 8 | Grant tests pass | **PARTIAL** | 11 tests pass; authority does not survive restart (handles are per-kernel) and fork resets budget ledgers |
| 9 | Capability-universality tests pass | **PASS** | Eight constructs, static no-branching gate in CI |
| 10 | Amendment reconciliation complete | **PASS** | A1–A14 applied across docs 02–15 and the ADR index |
| 11 | Architecture docs agree with executable behaviour | **FAILED** | Doc 17 §2 specifies redaction the format cannot perform; doc 11 §5 claims taint propagation that does not exist |
| 12 | Serialization evolution strategy exists | **PARTIAL** | Forward compatibility is now tested (doc 20, `evolution.test.ts`), but `schemaVersion` is write-only, there is no per-kind payload versioning, and no upcaster |
| 13 | Format/version migration strategy exists | **FAILED** | No migration mechanism of any kind |
| 14 | Adversarial re-review passes | **FAILED** | See above |

**7 of 14 criteria fail or are partial. The freeze does not proceed.**

---

## 2. Blocker taxonomy

The 44 blockers cluster into nine workstreams. Cluster size and independent rediscovery
matter: five reviewers found the grant-scoping defect separately, four found the
effect-claim timing defect separately. Convergent discovery is the strongest signal that
a finding is structural rather than stylistic.

### B1. Effect identity is claimed too late (4 reviewers, FATAL)
The effect key is written to the index at *settlement*, but read at *admission*, with an
`await` in between. Two concurrent invocations of the same key both pass the gate; an
invocation that becomes `uncertain` leaves no claim at all, so a retry re-executes it.
**Resolution:** claim the key at admission as an in-flight record; treat in-doubt claims
as blocking for unsafe classes. This is a record-format change (a new claim event).

### B2. Grants are per-execution copies (5 reviewers, FATAL)
`fork()` copies grant states into the child, so each fork gets a **fresh copy of the
remaining budget**, and revocation in the parent does not reach a child that already
forked. Budget lineage — a headline differentiator — does not survive forking.
**Resolution:** grants must be lineage-tree-scoped durable records keyed by grant id
across the correlation family, or forking must mint fresh attenuated grants. Either way
it is a record-format change.

### B3. Suspension discards landed external effects (2 reviewers, FATAL)
`settle()` returns on suspension *before* recording anything, so a capability that lands
an irreversible effect and then suspends loses the effect record entirely.
**Resolution:** an `external {landed:true}` proposal must be committed at yield time as
world truth, not held as a candidate.

### B4. Derived security state is not a real fold (3 reviewers, FATAL)
`effectIndex` and `protectedEffects` are built by different code live vs on recovery.
F-6 and F-8 were two instances of this class; the reviewers found more.
**Resolution:** make them derive exclusively inside `applyToProjection` from explicit
`effect.landed` / `effect.protected` events. Invariant I25 (added this phase) is the
regression net.

### B5. `resumeInvocation` is a second unguarded settlement path (2 reviewers, FATAL)
It re-implements admission badly: no authority chain check, no policy, no reservation,
and it does not release staging on error.
**Resolution:** collapse `invoke` and `resumeInvocation` onto one settlement path.

### B6. Recovery performs no integrity verification (2 reviewers, SERIOUS)
`readJournal()` skips any record whose checksum fails and *continues*, so mid-journal
corruption silently truncates history rather than failing closed. The checksum also does
not cover `executionId` or `commitToken`.
**Resolution:** verify the chain while folding; fail closed and quarantine on any
non-trailing break; extend the checksum preimage to the whole record.

### B7. No schema evolution or migration (4 reviewers, SERIOUS)
`schemaVersion` is hardcoded and never read; `protocolVersion` is never compared; there is
no per-kind payload version and no upcaster. Forward tolerance is now tested, but
tolerance is not migration.
**Resolution:** per-kind payload versioning, a reader policy for unknown kinds
(must-understand vs ignore), an upcaster registry, and a golden-corpus conformance suite.

### B8. Specification claims the format cannot support (3 reviewers, SERIOUS)
Redaction-by-tombstone requires a `payloadHash` in the hash preimage — there is none.
`leaseEpoch` is declared in the record and implemented nowhere. Taint is claimed as a
kernel invariant in doc 11 and does not exist in the kernel.
**Resolution:** implement, or normatively downgrade and say so. Both are acceptable;
silence is not.

### B9. No time (1 reviewer, SERIOUS)
No wall clock, deadlines, timers or heartbeats exist. `occurredAt` is a logical counter.
Doc 08 promises durable timers and deadlines.
**Resolution:** add an observed wall-clock field alongside the logical sequence, plus
deadline fields and timer events — or remove the promises.

---

## 3. What this phase nevertheless established

The review distinguished sharply between the *kernel semantics* (largely sound) and the
*record format* (not freezable), and that distinction is the useful result:

- The **structural commit barrier holds**. Every reviewer who attacked it failed to reach
  durable truth from inside a provider. The event-sourcing reviewer stated it explicitly.
- **Resume and fork are correctly separated**, resolving phase 1's FATAL-1 at the level
  of the semantics, even though the fork's *record* is still incomplete (B2, B4).
- **Uncertainty is a real state**, not a guess.
- **Capability universality survives** the harder test, with a CI-enforced static gate.
- The **differential model and property machinery work** — they found F-5 and, once
  invariant I25 was added, immediately found the effect-identity reconstruction gap.

Eight defects were found and fixed *during* this phase (F-1…F-8 in doc 20). The
remaining 44 are catalogued rather than fixed, because fixing them is a work programme,
not an edit.

---

## 4. Path to freeze

A defensible freeze needs one more focused phase, in this order:

**Wave S1 — record-format completion (blocks everything else).**
B1 (admission-time effect claims), B2 (lineage-scoped grant ledger), B3 (landed effects
committed at yield), B4 (single fold, explicit effect events), B8 (payloadHash; delete or
implement leaseEpoch). All five are record-format changes and must land together, because
each adds or moves fields.

**Wave S2 — integrity and evolution.**
B6 (fail-closed recovery, full-record checksum), B7 (per-kind payload versions, upcaster
registry, golden corpus), plus a normative canonicalization (RFC 8785 JCS or dag-cbor) and
a declared admissible value domain.

**Wave S3 — implementation hygiene.**
B5 (single settlement path), B9 (time), concurrency model declared normatively and
enforced (single-writer per execution, with a storage-level compare-and-set).

**Wave S4 — re-verification.**
Re-run the full suite plus every reviewer's reproduction script as regression tests, then
a third adversarial review scoped to the changed surface. Freeze only if that review
produces no FATAL and no freeze-blocking SERIOUS finding.

**Estimated shape, not schedule:** S1 is the bulk of the work and touches every record
type. S2 is mechanical but exacting. S3 is ordinary engineering. The honest statement is
that the format is roughly one focused phase away from freezable, and that this phase's
44 findings are the specification for that work.

---

## 5. What must NOT happen

- **Do not freeze incrementally.** B1–B4 and B8 all add or move fields; freezing part of
  the format now guarantees a breaking change later.
- **Do not start the production kernel.** The mission's next step was contingent on a
  freeze; that contingency failed.
- **Do not treat the passing suite as reassurance.** 45 tests passed while the kernel
  double-executed an irreversible effect across a fork restart. The suite was extended
  (I25) precisely because green was not evidence.
