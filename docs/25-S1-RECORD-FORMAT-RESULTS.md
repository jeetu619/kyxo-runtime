# 25 — Wave S1: Record-Format Completion Results

Date: 2026-08-16. Branch: `claude/wave-s1-record-format`, cut from `main` at the
architecture-baseline merge (18b39b9).

**Status of this document: results, not a freeze.** Doc 22 declared the record format NOT
READY TO FREEZE with 52 blocking findings. This wave attacked the record/lifecycle cluster
of those blockers — B1, B2, B3, B4, B8, and the two reproduction-backed findings B9a and
B9b — as **one coherent revision**, then tried hard to break the result. Section 6
reassesses the freeze criteria; the format is closer, and it is still not frozen.

**Scope discipline.** This wave did not build Kyxo Code, IDE integrations, Kyxo Platform
integration, a production public SDK, an agent framework, or provider integrations. It
changed a record format and the semantics that format encodes. Everything under
`prototypes/` remains prototype code (rule C11, doc 23).

---

## 1. Why one revision rather than six

B1, B2, B3, B4, B8, B9a and B9b were reported as separate findings, but they are not
separately fixable. Each one changes what a committed record must contain:

| Blocker | New record obligation |
|---|---|
| B1 | a claim must exist as a committed record *before* dispatch |
| B2/B9b | budget must be a ledger keyed by grant id across a lineage tree, in every unit |
| B3 | a landing must be committed at yield, not held as a candidate |
| B4 | all derived state must come from one fold, so the records must be sufficient for it |
| B8 | every event must carry a payload hash, and the chain must cover the hash |
| B9a | protection must be a durable ledger consulted across the whole lineage tree |

Landing them separately would have meant six breaking revisions of the same records, and
five intermediate formats that nobody should ever write to disk. The revision is
`2026-08-17`, replacing `2026-08-16`.

**No migration is provided, and none is owed.** No production data exists in the phase-2
format; the only writer is a prototype. This is precisely the window in which breaking the
format is free, which is the argument for doing the breaking now rather than after freeze.

---

## 2. What the revision changes

### 2.1 Claims at admission (B1)

Admission is a **synchronous critical section** containing no `await`: protection check,
dedup check, claim conflict check, authority, policy, reservation, and the commit of
`invocation.admitted` + `effect.claimed` + `grant.reserved` + `invocation.dispatched`.
Between reading the claim table and committing the claim, no other invocation can run.

Two guards keep that a property rather than an intention:

- a **static guard** (`tests/s1-concurrency` R4) reads `src/s1-kernel.ts`, extracts the
  region between its markers, strips comments, and fails if `await`, `.then(` or `yield`
  appears. Adding a suspension point there fails CI.
- a **runtime re-entrancy guard** throws `AdmissionReentrancyError` if the region is
  re-entered. Without it the region's atomicity is a comment; with it, a violation is a
  loud failure instead of a double dispatch.

### 2.2 Family-scoped grant ledger (B2, B9b)

A *family* is a lineage tree: the root execution and every execution forked from it,
directly or transitively. One ledger per grant id serves the whole family, so no fork can
reset or multiply authority. Attenuation walks the chain, and the effective limit for a
unit is the minimum along it.

Every declared unit is reserved at admission and settled at outcome. A unit that no grant
in the chain mentions has capacity **zero, not unlimited** — a grant enumerates the
authority it confers, exactly as it does for rights, so forgetting a unit fails closed.

### 2.3 Landings commit at yield (B3)

`effect.landed` is committed the instant a capability reports it. Tests take a landing
through every exit an invocation has — suspension, thrown exception, declared failure, and
a crash between the yield and the outcome — and it survives all four.

`resume()` was added because suspension without resumption is a one-way door: the claim and
the reservation stayed held forever. Resume picks up the existing lease rather than
re-admitting, and reads the reservation and the original request **from the journal**, so a
suspended invocation is resumable from a cold start.

### 2.4 One fold (B4)

`src/s1-fold.ts` is the only code that turns records into derived state. `digest()` makes
"live state equals replayed state" checkable **by value**, and the property suite asserts
it after every step of every generated sequence — and over every committed *prefix*, not
just the final journal. A fold that is only correct at the end has a hidden dependency on
arrival order.

### 2.5 payloadHash and redaction (B8)

Every event carries `payloadHash`; the chain covers the hash, not the payload. This
separates three cases the old format could not distinguish:

| Operation | Chain verifies | Payload matches its hash |
|---|---|---|
| lawful redaction (tombstone) | yes | marked redacted |
| silent payload rewrite | yes | **no** — detected |
| payload + hash rewritten together | **no** — the hash is in the preimage | n/a |

### 2.6 Lineage-tree protection (B9a)

An exclusive effect landed anywhere in the family binds the whole family, regardless of
topology or of which cut a child came from. This reverses a decision made earlier in this
same wave; see §4.

---

## 3. Evidence

175 tests, 11 seconds, zero failures. 129 are new in this wave.

| Suite | Tests | What it establishes |
|---|---:|---|
| `s1-concurrency` | 13 | B1 under 2/5/20/100 concurrent invocations, mid-flight arrival, forced interleave inside the admission region, post-crash uncertainty, and the static no-await guard |
| `s1-lineage` | 8 | B9a: cut-before-landing, siblings, forged resolution records, cross-family isolation, restart |
| `s1-grants` | 16 | B2/B9b: fork cannot reset or mint budget, every unit enforced, metered vs unmetered settlement, attenuation, transitive revocation, handle forgery |
| `s1-effects` | 12 | B3: landings survive every exit; resume; uncertainty dispositions |
| `s1-integrity` | 12 | B8 and B6: redaction vs tampering, whole-record checksum, fail-closed recovery, golden corpus, versioning |
| `s1-crash` | 19 | 18 named crash positions plus an exhaustive sweep (every durable write, clean and torn) |
| `s1-fork` | 12 | fork matrix across cut position, parent state, and lineage depth |
| `s1-property` | 26 | differential against an independent model, plus properties checked after every step |
| `s1-security` | 11 | attacks assuming untrusted, hostile, in-process capability code |
| phase-2 suites | 46 | unchanged and still green |

### 3.1 Deterministic concurrency

No sleeps and no timing luck anywhere. Three mechanisms:

- **same-tick burst** — N invocations started in one synchronous turn. Deterministic
  because admission completes before `invoke` first suspends.
- **mid-flight arrival** — the incumbent parks inside its generator on a barrier that
  *signals when it has been reached*, so competitors run while it is provably parked.
- **forced interleave** — a competitor is driven into the middle of the incumbent's
  admission region through a test hook: the exact interleaving a broken critical section
  would allow, which real in-process concurrency cannot even produce.

Every race test asserts against a **world counter**, not against journal bookkeeping,
because the journal can look perfect while the card is charged twice.

### 3.2 The independent reference model

`reference-model/s1-model.ts` imports nothing from the fold, the kernel or the invariants.
It never sees an event, a hash chain or a projection — it is the intended semantics
restated from the specification. That independence is the whole point: a model derived
from the fold would agree by construction and faithfully reproduce the implementation's
bugs.

It disagreed four times. Twice the model was wrong; twice the kernel was (F-18, F-19).

---

## 4. Falsifications

Nine findings, F-11 to F-19, recorded in full in doc 20. Three deserve calling out here.

### F-12/F-13 — the wave falsified its own load-bearing decision

The first implementation of B9a scoped protection to the **ancestor path**: an execution
was bound by effects landed by itself and its ancestors, but not by a sibling's. The
rationale was that siblings are divergent world-lines, and the file header called this
asymmetry "the load-bearing decision of this wave".

It is wrong, and the tests said so. **The external world is not forked.** A lineage tree is
bookkeeping; a charged card is a fact. B9a's ratified resolution had already said
lineage-tree-scoped, "consulted regardless of which cut a child came from", and the
implementation had quietly narrowed it.

Worse, under path scoping the design had *two* mechanisms answering one question
differently: `protectionFor` said a fork from before the charge was unbound, while the
family-wide claim table refused it anyway. The safer mechanism was winning by luck. Test
L3 removed the luck — `abandon-failed` on an uncertain invocation deleted the claim even
though a durable `effect.landed` record existed — and a fork charged the card a second
time.

Both are fixed. Protection is family-scoped, the ancestry walk and its visibility horizon
are deleted (one scope, one rule, fewer mechanisms), and an operator can no longer declare
a recorded landing to have failed. The superseded asymmetry is marked as superseded in the
record-format header rather than rewritten out of history.

### F-15/F-16 — budget enforcement rested on capability honesty

Reservations were built from the caller's `estimate` alone, so any unit the caller declined
to estimate was never reserved and never settled: token budgets were bypassable by not
mentioning tokens. And settlement charged capability-*declared* usage, so a capability
declaring zero could run forever against a finite budget.

Both make a safety property depend on untrusted code, which contradicts the pure-proposer
stance the whole architecture rests on. The revision introduces **unit policy** in the
capability manifest — a declared, negotiated property, the kind of thing the kernel is
allowed to branch on:

- the reservation is the per-unit **maximum** of the manifest floor and the caller's
  estimate. Neither side can shrink it.
- a **metered** unit is one where the provider reports authoritative consumption (an LLM
  returning token counts). A declaration below the reservation is believed, so an
  over-estimate is refunded.
- an **unmetered** unit is one nobody measures. The full reservation is charged whatever
  the capability claims.

### F-19 — a capability could claim it touched the world without the class to do so

Found by differential testing. A capability declaring class `local` yielded
`{type: 'external', landed: true}`; the kernel recorded a landing, but protection keys off
the declared *class*, and `local` is not exclusive — so the landing bound nothing and the
same external effect could be repeated freely.

The class is a negotiated manifest property fixed before the invocation; the proposal is
per-yield and untrusted. Where they disagree the manifest wins, and the disagreement is
journaled.

---

## 5. Blocker reclassification

The 52 findings cluster into the eleven headings of doc 22 §2. Status after this wave:

| # | Blocker | Status | Basis |
|---|---|---|---|
| B1 | Effect identity claimed too late | **RESOLVED** | Claims commit at admission inside a synchronous critical section, guarded statically and at runtime. 13 deterministic race tests at 2/5/20/100, plus post-crash. |
| B2 | Grants are per-execution copies | **RESOLVED** | One family-scoped ledger per grant id; forks inherit spent state; revocation is transitive and survives restart. 16 tests. |
| B3 | Suspension discards landed effects | **RESOLVED** | Landings commit at yield and survive suspension, exception, failure and crash. `resume()` closes the one-way door. 12 tests. |
| B4 | Derived state is not a real fold | **RESOLVED** | `s1-fold.ts` is the only reconstruction path; `digest()` makes equality checkable; asserted over every committed prefix. |
| B5 | `resumeInvocation` is a second settlement path | **RESOLVED** | `invoke` and `resume` share one `run()` and one `settle()`. Resume does not re-admit; it picks up the existing lease. |
| B6 | Recovery performs no integrity verification | **RESOLVED** | Whole-record checksum; per-event chain and payload-hash verification in the invariant set; recovery **fails closed** on non-trailing corruption, with quarantine as an explicit override. |
| B7 | No schema evolution or migration | **PARTIAL** | `protocolVersion` is stamped and inside the hash preimage; unknown kinds advance the cursor without changing semantics; a golden-corpus conformance test exists. **Still missing: per-kind payload versioning, a must-understand/ignore reader policy, and an upcaster registry.** |
| B8 | Spec claims the format cannot support | **PARTIAL** | `payloadHash` implemented and redaction demonstrated. **`leaseEpoch` and taint remain declared-but-absent and must be implemented or normatively withdrawn.** |
| B9a | Protection is cut-scoped | **RESOLVED** | Family-scoped ledger, derived by fold, consulted regardless of cut. Reversed a wrong narrowing made inside this wave (F-12). 12 fork tests + 8 lineage tests. |
| B9b | Declared usage settled without validation | **RESOLVED** | Every unit reserved and admission-checked; settlement capped at the reservation; metered/unmetered distinction removes reliance on capability honesty. |
| B9 | No time | **UNCHANGED** | No wall clock, deadlines, timers or heartbeats. `occurredAt` is still a logical counter. Out of scope for this wave; doc 08's promises remain unmet. |

**Eight resolved, two partial, one unchanged** — eleven clusters.

A note on the arithmetic: doc 22 counted 52 individual findings clustering into these
eleven headings, and this table reclassifies the **clusters**, which is the unit at which
the resolutions were designed. The residue inside B7, B8 and B9 is named explicitly above
rather than absorbed into a cluster-level "resolved".

---

## 6. Freeze reassessment

Doc 22's fourteen criteria, restated against current evidence:

| # | Criterion | Was | Now | Note |
|---|---|---|---|---|
| 1 | Semantic specification complete | PARTIAL | **PARTIAL** | Redaction is now real; `leaseEpoch` and taint are still claimed and absent |
| 2 | No unresolved FATAL issues | FAILED | **PARTIAL** | The FATAL record/lifecycle cluster is resolved; no adversarial re-review has been run against the new format |
| 3 | Property tests pass | PASS | **PASS** | 175 tests; invariants asserted after every step of every generated sequence |
| 4 | Deterministic model comparison | PASS | **PASS** | Independent model sharing no code with the fold; 24 seeded sequences, 200×80 in CI |
| 5 | Crash matrix passes | PARTIAL | **PASS** | 18 named positions + exhaustive sweep; recovery fails closed on mid-journal corruption |
| 6 | Fork tests pass | PARTIAL | **PASS** | 12-test matrix across cut position, parent state, lineage depth |
| 7 | Dedup tests pass | PARTIAL | **PASS** | Claims at admission; races at 2/5/20/100; in-flight limit for non-exclusive classes stated explicitly |
| 8 | Grant tests pass | PARTIAL | **PASS** | Family ledger survives restart; `rehydrateGrant` restores handles without restoring spent authority |
| 9 | Capability-universality | PASS | **PASS** | Unchanged; static no-branching gate still in CI |
| 10 | Amendment reconciliation | PASS | **PASS** | Unchanged |
| 11 | Docs agree with executable behaviour | FAILED | **PARTIAL** | Doc 17 §2 redaction is now true; doc 11 §5 taint is still false |
| 12 | Serialization evolution strategy | PARTIAL | **PARTIAL** | Version stamped and hashed, unknown kinds tolerated, golden corpus; no per-kind versioning or upcaster |
| 13 | Format/version migration strategy | FAILED | **FAILED** | Still no migration mechanism. Deliberately unaddressed: there is no data to migrate, and inventing a mechanism before there is a second format to migrate *to* would be speculative |
| 14 | Adversarial re-review passes | FAILED | **NOT RUN** | The new format has not been through an independent adversarial review |

**Score: 8 PASS, 4 PARTIAL, 1 FAILED, 1 NOT RUN.** Six of fourteen are failing, partial or
not run; ten of fourteen were before.

(Doc 22's summary line says "7 of 14 criteria fail or are partial", but its own table tallies
4 PASS + 6 PARTIAL + 4 FAILED = **10 of 14**. That error is on `main` and predates this wave;
it is named here rather than corrected in place, because a freeze decision edited after the
fact stops being evidence. It understates the prior baseline, so the improvement this wave
made is slightly larger than doc 22's summary implies, not smaller.)

> **SUPERSEDED BY §11.** The reassessment above was written before the independent
> adversarial review had run. Six reviewers subsequently found defects that all 177 tests
> in this wave had missed, several of them FATAL and several in the very blockers this
> section marks RESOLVED. §11 is the current status; this section is left as written
> because a self-assessment edited after independent review stops being evidence of what
> self-assessment is worth.

### Decision: **STILL NOT READY TO FREEZE**

Not because the remaining items are large, but because two of them are exactly the kind
that freezing makes permanent:

1. **Criterion 14 has not been run.** The last independent adversarial review broke the
   format within hours and produced 52 blockers. This wave's evidence is written by the
   same author as the design, and the four defects the differential model found (F-18,
   F-19 among them) are a direct demonstration that self-review misses things that
   independent construction catches. Freezing on self-review after the previous round
   would be learning nothing from it.
2. **B8's residue is a specification lie, not a gap.** `leaseEpoch` and taint are declared
   in normative documents and do not exist. Freezing a format whose spec describes fields
   that are absent bakes in the discrepancy.

B7 and criterion 12 are real but different in kind: they are additive. Per-kind payload
versioning and an upcaster registry can be added without invalidating records already
written, provided the envelope carries enough version information to hang them on — and it
now does. They are not freeze blockers on their own.

---

## 7. Limits of this design, stated

These are not open questions to be resolved later; they are properties of the design as
built, each pinned by a test so a future change has to confront them.

**Single writer per family.** Admission's atomicity is in-process. Multi-writer safety
would require storage-level compare-and-set and is **not claimed**. The concurrency
contract is stated at the top of `s1-kernel.ts`.

**In-flight dedup does not exist for non-exclusive classes.** Two concurrent invocations of
the same `external-idempotent` key both dispatch; only sequential duplicates dedup against
a terminal outcome. Safe by declaration — idempotent means repeatable — but it is a real
limit, asserted in `s1-concurrency` R6.

**Re-entry after suspension is a capability-contract obligation.** A capability that
ignores `ctx.resume` and calls the API again really does charge twice, and no kernel
outside the network path can stop it. What the kernel guarantees is that its records stay
coherent: one landing in the ledger, the repeat journaled as a duplicate, protection
unaffected. Pinned by `s1-effects` E7, which uses a deliberately badly-behaved capability
and asserts the world was touched twice.

**Metered units are trusted downward.** For a metered unit the kernel believes the
provider's reported consumption, because the authority that reports usage is the authority
that bills. A dishonest declaration under-charges. The kernel's hard guarantee is the
admission-time one — no invocation is admitted without room for its reservation — and no
kernel that cannot itself measure tokens can promise more. Pinned by `s1-grants` G4d.

**Redaction is a multi-event operation.** The same datum appears in more than one payload:
`invocation.admitted` carries the request so a suspended invocation can be re-entered from
a cold start, and `state.updated` carries what was derived from it. Erasure must find every
event carrying it. `s1-integrity` I2 asserts the exact duplication count, so a revision that
adds another copy fails the test and someone has to look. Carrying sensitive payloads by
artifact reference is the structural answer and was out of scope here.

**A capability can touch the world more than once inside one invocation.** The kernel
cannot prevent it; it guarantees the ledger still records one landing per key.
`s1-security` A5.

---

## 8. What this wave did not do

Deliberately, per the wave's stated non-goals: no Kyxo Code, no VS Code or JetBrains
integration, no Kyxo Platform integration, no production public SDK, no agent framework,
no provider integrations beyond the fixtures needed for semantic testing.

Architecturally out of scope and still owed:

- an independent adversarial review of the `2026-08-17` format (criterion 14)
- `leaseEpoch` and taint: implement or normatively withdraw (B8)
- per-kind payload versioning, must-understand policy, upcaster registry (B7)
- time: wall clock, deadlines, timers, heartbeats (B9)
- `allowReplayOfProtected` — the explicit, journaled override for deliberately repeating a
  protected effect. It exists in the phase-2 `ForkOptions` type and is **not implemented**
  in the S1 kernel. Every protected effect is currently unconditionally refused.

---

## 9. Governing constraints, checked

The wave was given fourteen constraints. Each still holds, with the evidence:

| Constraint | Evidence |
|---|---|
| Capability remains a generic abstraction | `universality.test.ts` static gate, **which now globs `src/*.ts`** — it previously named two files and did not read the S1 kernel at all (§4, F-21). The kernel branches on effect class and unit policy, both declared manifest data |
| Agent is not a kernel primitive | No agent concept anywhere in `src/` |
| Capability Kind does not determine kernel semantics | Branching is on `effectClass` and `units`, never on identity or kind |
| Provider identity does not determine kernel semantics | Effect identity is derived from `(capabilityId, step, canonical(request))`; no provider branch exists |
| Capabilities are pure proposers | `InvokeCtx` carries data only; asserted structurally by `s1-security` A10 |
| Userland cannot write authoritative truth | Every state change goes through `commit()`, and F-19 closed the route by which a proposal could assert something its **class** did not permit. **Not "the last route"** — a capability whose class *does* permit external effects can still report a landing that never happened, permanently. See §7 and `s1-security` A12 |
| Commit authority belongs to the kernel | `commit()` is private; the fold runs only after the durable write |
| Orchestration remains above the kernel | No scheduler, planner or loop in `src/` |
| Resume and fork remain distinct | `resume()` continues a lineage and its lease; `fork()` branches one. `s1-fork` F7 asserts a fork cannot seize a suspended invocation's effect |
| Uncertainty remains explicit | `invocation.uncertain` is a state, never a guess; `s1-effects` E11 |
| Grants remain generic runtime authority | Rights are opaque strings; units are open; no Kyxo-specific role model exists |
| Live-state protections survive recovery | I25 and S1-I3; every crash test restarts from storage alone |
| Kyxo Platform, Kyxo Code and IDE concepts must not enter the kernel | No product, IDE or platform identifier appears in `src/`; verified by grep, and by doc 23's C11 boundary |
| Prototype code is still prototype code | Nothing under `prototypes/` is imported by a production package (C11); §1 and §10 both refuse to authorise production implementation |

---

## 10. Recommendation

Proceed to an **independent adversarial review of the `2026-08-17` format** before any
further construction on top of it. Do not begin production implementation of the record
format, and do not freeze.

The previous review's value was that it was independent and hostile, and it found 52
things. This wave's four model-versus-kernel disagreements are a small-scale replication of
the same lesson: the defects that matter are the ones the author cannot see. Two of the
four were kernel bugs that every hand-written test in this wave had missed.


---

## 11. Independent adversarial review (criterion 14) — and what it overturned

Six reviewers — durable execution, security, event sourcing, distributed systems,
architecture invariants, SDK maintainer — were given the format, the tests and this
document, and wrote their own attack scripts. They were asked to break it, not to grade it.

**They broke it.** Roughly seventy findings, of which fourteen were FATAL with working
reproductions. Every FATAL was in a path this wave's 177 tests reach, and none of those
tests had caught any of them.

### 11.1 The result that matters most

Three of the blockers §5 marks **RESOLVED** were falsified:

| Blocker | §5 said | Independent review found |
|---|---|---|
| B1 | RESOLVED | A double charge with **one kernel, one process, zero concurrency** — a storage error that keeps the bytes but loses the ack left memory saying "not landed" while the journal said landed, so settlement freed the claim and the retry charged again (F-27). |
| B5 | RESOLVED | `resume()` performed **no** authority check, no policy, no budget check. A revoked grant and a deny-class kill switch were both ignored while the invocation reported `completed` (F-29). "One shared settlement path" was true; the admission half was not shared at all. |
| B6 | RESOLVED | `assertS1Invariants` had **zero call sites in `src/`**. The entire `payloadHash` apparatus was inert outside the test suite, and the record checksum links a record to itself and nothing before it — so payloads could be rewritten in place, and whole records **deleted or reordered** mid-journal, and recovery accepted all of it silently, losing a landing and charging again (F-31, F-32). |

The B6 finding is the sharpest lesson in the wave. The chain carried the evidence. The
verification code existed and was correct. **Nothing on the production path called it.**
"Implemented and tested" and "in force" turned out to be different claims, and this
document asserted the first while meaning the second.

### 11.2 What was fixed

Seventeen defects, F-21 to F-37, are fixed and pinned by tests (181 now pass). The
significant ones beyond the three above: the universality gate read two named files and
never scanned the S1 kernel at all, so the CI step named after the project's founding
invariant passed on four injected identity branches (F-21); this wave's own F-19 fix
**destroyed world truth** and was worse than the bug it fixed (F-22); budgets failed open
for units a capability did not declare, moving $25,000 against a $5 limit while reporting
the budget untouched (F-23); the kernel minted a per-attempt nonce into every delegated
effect key (F-24); `canonical()` hashed `Date`, `Map` and `Set` to `{}` so two different
requests shared one effect key (F-25); `estimate: {usd: NaN}` was type-correct and
permanently disabled budget enforcement family-wide (F-28); and `effect.released` addressed
claims by effect key rather than by the claim it owned, so one invocation revoked another's
lease (F-33).

The security reviewer's meta-finding is the one to carry forward: **almost every one of
these is the same mistake** — the kernel read a value it did not own more than once, or
kept a reference to it. Patching instances produced new instances twice during the review
itself. The fix is structural (F-36): a value crossing into the kernel is snapshotted into
kernel-owned plain data at the boundary and never re-read from the caller's object.

### 11.3 What is NOT fixed, and why that decides the freeze

These are known, reproduced, and open:

- **No writer identity or fence in the record format.** Two writers over one journal produce
  **byte-identical** commit records — same commit token, event ids, seq and `occurredAt` —
  so the violation is indistinguishable from an at-least-once redelivery. Saying multi-writer
  safety is "not claimed" is defensible; shipping a format in which the violation is
  *unattributable* is not, and the field cannot be added after a freeze.
- **Forward tolerance defeats protection.** A valid, correctly-signed journal from a future
  revision that renames `effect.*` is read by today's fold as a series of no-ops: the landing
  vanishes and the card is charged again, with every invariant green. This document argued
  B7 was "additive … not a freeze blocker on their own." That judgement is **wrong**, and it
  is the one conclusion here the evidence directly overturns — a must-understand bit added in
  a later revision tells a reader nothing about a record already written.
- **The journal is unauthenticated.** `sha` is unkeyed with no anchor or signature, so an
  attacker with disk access re-chains the whole journal and every check passes. §2.5's table
  describes per-event detection and reads as a general guarantee.
- **`family()` returns live mutable state**, and `rehydrateGrant` mints a handle for any
  grant id in the family — ids that are printed in the clear on every event — including
  revoked ones. Attenuation is bypassable in-process.
- **Ergonomics that produce double charges from ordinary code**: a nonce or timestamp in the
  request, a re-run job calling `createExecution()`, or a forgotten `step` (which defaults to
  `'anon'`). The SDK reviewer's summary is fair: the money-safety story is defeated by the
  four most ordinary things a developer does.
- **`expiresAt` is enforced in units of journal entries.** §5 files B9 as "out of scope";
  it is not merely absent, it is an enforced deadline with a meaningless unit.
- **Coverage is narrower than its labels.** The differential model never calls `suspend()`,
  `markUncertain()`, resume, cancel, fork or crash — every FATAL lives in exactly those
  paths. "Invariants asserted after every step of every generated sequence" is literally true
  and covers none of the surface that broke.

### 11.4 Revised status

| Criterion | §6 said | Now |
|---|---|---|
| 2 — no unresolved FATAL | PARTIAL | **FAILED** |
| 5 — crash matrix | PASS | **PARTIAL** — the sweep assumed "threw ⇒ nothing written", excluding the dominant real storage fault |
| 12 — serialization evolution | PARTIAL | **FAILED** — not additive; it is a live double-charge path |
| 14 — adversarial re-review | NOT RUN | **FAILED** |

| Blocker | §5 said | Now |
|---|---|---|
| B1 | RESOLVED | **PARTIAL** — fixed for the lost-ack case; no fencing field in the format |
| B4 | RESOLVED | **PARTIAL** — the fold is deterministic over an ordering the format does not define |
| B5 | RESOLVED | **RESOLVED** — resume now runs the same gates |
| B6 | RESOLVED | **PARTIAL** — verification is on the read path now; the journal is still unauthenticated |
| B7 | PARTIAL | **UNCHANGED** — and reclassified as a freeze blocker |
| B9a | RESOLVED | **PARTIAL** — protection is defeated by cross-family redelivery |
| B9 | UNCHANGED | **UNCHANGED**, and an active defect rather than an absence |

**Five resolved, five partial, one unchanged.**

### 11.5 Decision

**DO NOT FREEZE, and do not build on this format yet.** Not for the reasons §6 gave — those
were the wrong two items. The blocking set is: no writer identity in the format, no
must-understand reader policy, an unauthenticated journal, and an effect-identity model that
double-charges under ordinary developer behaviour. Each is a *format* change, which is
exactly the class of thing a freeze forecloses.

The recommendation in §10 was right and remains right, with one correction: it is not enough
to run an independent review once. Run it **against a tagged commit with a green suite**, and
re-run it after the fixes above, because two reviewers observed the tree changing underneath
them while they read it.

### 11.6 What this says about the method

§10 said "the defects that matter are the ones the author cannot see," offered as an argument
for independent review. It was a stronger claim than intended: seventeen of the defects fixed
in this wave were found by someone other than the author, in one round, against a suite the
author had built specifically to find them and which was green.

The corollary is uncomfortable and worth stating plainly. This document's §5 and §6 were
written in good faith and were wrong about three RESOLVED blockers and two criteria. A
results document written by the implementer is evidence about the implementation, not about
its safety, and it should be read as the former until something adversarial has been pointed
at it.
