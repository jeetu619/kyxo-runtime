# 19 — Crash Recovery Model

Status: **EXECUTABLE**, 2026-08-16.

> **EXTENDED by Wave S1 (2026-08-16).** The matrix below covers the phase-2 kernel and still
> passes. The `2026-08-17` format has its own matrix in
> `prototypes/kernel-semantics/tests/s1-crash.test.ts`: **18 named positions** plus an
> exhaustive sweep (a crash before every durable write of a rich workload, clean and torn,
> with the full S1 invariant set asserted after each restart).
>
> Two recovery semantics changed and this document does not yet describe them:
>
> - **Recovery fails closed on non-trailing corruption** (B6, ADR-027). A trailing bad record
>   is an interrupted write and is discarded; a bad record with valid records after it is
>   corruption, and folding past it deletes history from the middle of the log. Quarantine is
>   an explicit operator override, never a default.
> - **A landing is durable from the moment it is yielded** (B3, ADR-028), so a crash between
>   the yield and the outcome leaves the OUTCOME unknown while the LANDING is known — a
>   distinction the phase-2 model could not represent.
>
> Crash positions are now named by event kind rather than by counting durable writes.
> Counting is brittle: a stale count silently tests the wrong moment, or never fires and
> passes for the wrong reason. Both happened while this suite was being written. Every row of the crash matrix below is exercised by
`prototypes/kernel-semantics/tests/crash.test.ts`, either by the systematic sweep (a
crash injected before every durable write in a representative workload, in both clean
and torn-write variants) or by a named scenario test.

---

## 1. The failure model

**What can fail:** the process (at any instruction), a durable write (partially — a torn
record), a capability (by error or by dying mid-effect), an external system (by
succeeding, failing, or becoming unreachable at the worst moment), and a human (by never
answering).

**What is assumed sound:** storage does not silently corrupt already-acknowledged
records, and a torn trailing record is detectable. Both assumptions are enforced in the
prototype (checksum per commit record, trailing-record discard on read) and both are
standard requirements on real storage.

**What the kernel guarantees under these failures** is stated in doc 17 §5.1 and is
deliberately *not* "exactly once": at-most-once for observed effects, at-least-once for
safe classes, explicit uncertainty for unsafe ones.

## 2. The atomicity decision that removes three failure states

Kyxo has **no separate append and commit phases**. A commit record — containing all
events produced by one settlement, plus the budget movements and artifact references
they imply — is written as a single atomic record. There is no prepare, no two-phase
handshake, no window in which events are "appended but not committed".

This is why the mission's crash points 4 ("during journal append"), 5 ("after append
before commit") and 6 ("during commit") collapse into one state in this design: the
record either validates on read or is discarded. The design eliminates the failure
class rather than handling it.

The cost, stated honestly: a settlement's events cannot span records, so a single
settlement must fit in one atomic write. For AI workloads whose payloads live in the CAS
and whose events carry references, this is not a practical constraint — but it *is* a
constraint, and a workload that produced an unbounded number of events in one settlement
would hit it.

## 3. The crash matrix

Legend for coverage: **sweep** = exercised by the systematic every-write-point sweep
(16 durable write points × {clean, torn} = 32 recovery runs per suite execution);
**named** = a dedicated scenario test.

| # | Crash point | Kernel state after restart | Recovery action | Coverage |
|---|---|---|---|---|
| 1 | Before invocation dispatch | Admission + reservation committed, or nothing | Reservation is released by recovery triage; the invocation never ran | sweep |
| 2 | After dispatch, before response | `dispatched` with no outcome | Triage by effect class: safe → re-lease; unsafe → `uncertain` | sweep + named |
| 3 | **External effect succeeded, journal not yet written** | `dispatched` → `uncertain` | Never auto-retried. Resolution requires an explicit disposition (probe / adopt-landed / compensate / abandon-failed), each journaled | named (`crash after an irreversible external effect lands…`) |
| 4 | During journal append | — | Structurally merged with #6: the record is torn and discarded on read | sweep (torn variant) |
| 5 | After append, before commit | — | Structurally impossible: append *is* commit (§2) | n/a by design |
| 6 | During commit | Record torn | Discarded on read; state is as if the settlement never happened; staged effects are gone with the process | sweep (torn variant) |
| 7 | Immediately after commit | Fully committed | Projections re-fold from the journal; no action needed | sweep |
| 8 | During artifact persistence | Blob may or may not exist; no event references it yet | Orphan blob is inert (unreferenced); the invocation is treated as #2 | sweep |
| 9 | During checkpoint construction | Snapshot blob may exist; no `checkpoint.cut` event | No checkpoint exists; the execution continues from the journal | sweep |
| 10 | After checkpoint persisted | Checkpoint durable and reloaded on recovery | Available for resume and fork | named (`checkpoint written but crash immediately after`) |
| 11 | During resume | Resume writes nothing until the resumed invocation settles | The checkpoint and journal are untouched; resume can simply be re-attempted | sweep |
| 12 | During fork creation | Either the `execution.forked` record landed or it did not | No half-born lineage: a crashed fork leaves no execution at all | named (`crash during fork creation leaves no half-born lineage`) |
| 13 | During duplicate handling | The dedup record either committed or not | If it did not, the duplicate is simply re-detected and re-journaled on retry — the effect still runs once | sweep |
| 14 | While an outcome is unknown | `uncertain` persists across restarts | It is a durable state, not an in-memory flag; it survives any number of restarts until dispositioned | named |
| 15 | While waiting for human approval | `suspended` with a typed payload | The payload is in the journal; resume re-enters the provider with it. A human who never answers leaves a durable, visible suspension — not a lost thread | named (universality suite: suspend → resume) |

## 4. Recovery algorithm

```
recover(storage):
  1. reload durable checkpoints            # else forks die at restart (F-4)
  2. read journal, discarding torn trailing records
  3. for each commit record, in order:
        fold events into the execution's projection
        rebuild effect identity from committed outcomes
  4. triage every invocation still in `dispatched`:
        effect class safe        -> re-leasable
        effect class unsafe      -> commit `invocation.uncertain`
  5. return (kernel, uncertain[], discardedRecords)
```

Properties asserted after every recovery in the test suite: hash chain intact, seq dense
and monotonic, no staged candidate present, budgets non-negative and within limits,
every artifact reference resolvable, every execution beginning with a lineage-origin
event.

## 5. Uncertainty: the state that most systems lack

When an unsafe external effect was dispatched and no outcome was recorded, three things
are true simultaneously: the effect may have landed, retrying may double-apply it, and
declaring failure may lose real work. The kernel therefore records `uncertain` and stops.

Resolution is always explicit and always journaled:

| Disposition | Meaning | Requires |
|---|---|---|
| `probe` | Ask the capability whether the effect landed | `probeable` trait |
| `adopt-landed` | An authority asserts it landed | A recorded authority (human/operator/system) |
| `compensate` | Reverse it, then treat as failed | `compensatable` trait |
| `abandon-failed` | An authority accepts the loss | A recorded authority |

A probe that answers `unknown` leaves the invocation `uncertain`. The kernel never
converts ignorance into a verdict — verified by a dedicated test.

## 6. What this model does not solve

Stated plainly, because a recovery model that claims completeness is lying:

- **A capability that lies about its effect class** defeats the triage. The kernel
  cannot verify that a "declared idempotent" endpoint really is. Mitigation is
  contractual and observational (probes, telemetry), not structural.
- **Compensation is best-effort.** A compensation that itself fails leaves the
  invocation `uncertain` — correctly, but unhelpfully. Some effects have no inverse.
- **Long-lived uncertainty is an operational burden**, not a solved problem. The design
  makes it visible and attributable; a human or policy must still decide.
- **Storage that silently corrupts acknowledged records** breaks the model, as it breaks
  every journal-based system.
- **The atomic-settlement constraint** (§2) bounds how much one settlement may produce.
