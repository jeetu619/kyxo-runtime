# 20 — Semantic Test Results

Status: 2026-08-16. This document records what was tested, what was found, what was
fixed, and what remains at risk. **It deliberately leads with the failures**: a phase
whose purpose is falsification should be judged by what it falsified, not by a green
tick.

Reproduce everything:

```bash
cd prototypes
npm install
npx tsc --noEmit
node --experimental-strip-types --test kernel-semantics/tests/*.test.ts
KYXO_FUZZ_SEEDS=1000 KYXO_FUZZ_LENGTH=70 node --experimental-strip-types kernel-semantics/fuzz.ts
```

---

## 1. Suites and scale

| Suite | Tests | What it establishes |
|---|---|---|
| `crash.test.ts` | 6 | Systematic crash sweep (16 write points × clean/torn = 32 recoveries) + landed-but-unrecorded effects, unknown probes, compensation, safe re-lease, checkpoint consistency |
| `fork.test.ts` | 9 | Cut isolation, parent immutability, protected-effect refusal, explicit override, mandatory dispositions, sibling and nested independence, crash-during-fork, resume-vs-fork distinction |
| `dedup.test.ts` | 5 | Six mechanisms kept distinct; CAS dedup preserves per-producer provenance; content-inclusive effect keys; budget not double-charged |
| `grants.test.ts` | 11 | Handle forgery (3 attacks), attenuation limits, lineage accounting, admission denial, transitive revocation, expiry, fork-vs-revocation, delegation attenuation, two recursion bounds |
| `universality.test.ts` | 6 | Eight heterogeneous constructs on one path, static no-type-branching gate, malicious capability containment, deny-class policy, mixed-class checkpoint/fork/recovery, commit gate across suspension |
| `property.test.ts` | 3 | 120 seeded sequences × 40 ops with per-operation invariant assertion and a delta-debugging minimizer; differential agreement with the reference model on outcomes, budgets and fork isolation |
| `coverage.test.ts` | 1 | 150 seeds × 30 ops with a distribution guard that fails if interesting states stop being reached |
| `evolution.test.ts` | 5 | Serialization compatibility: unknown kinds/fields tolerated and retained, hash covers unknown fields, torn-record discard, per-event version stamps, unknown lineages materialize |
| **Total** | **46** | all passing; TypeScript strict, zero runtime dependencies |

**Volume per full run:** 4,500 coverage operations + 4,800 property operations + 32
crash-point recoveries, with a complete invariant check after **every** operation
(9,300 invariant evaluations). Extended fuzz adds 70,000 operations over 1,000 seeds
(191 s wall-clock), all clean.

**Coverage distribution** from the most recent 150-seed run — this is what the generated
workloads actually reached, not what they could have:

| State reached | Count | | State reached | Count |
|---|---:|---|---|---:|
| invocations admitted | 2,765 | | forks created | 374 |
| invocations completed | 2,130 | | crashes injected | 375 |
| invocations failed | 635 | | recoveries performed | 375 |
| artifacts produced | 1,341 | | uncertainties raised | 375 |
| checkpoints cut | 538 | | uncertainty resolutions | 375 |
| grants attenuated | 538 | | duplicate deliveries | 294 |
| grant reservations | 2,765 | | grants revoked | 278 |
| grant settlements | 1,941 | | policy denials | 299 |
| grant releases | 449 | | effect dedup hits | 69 |

The coverage guard asserts minimum counts for eighteen of these; the suite fails if the
generator degenerates.

---

## 2. Design falsifications (the substance of this phase)

Ten findings emerged from execution (F-1…F-10). Each was a *design* error, not a typo,
and most existed in the written specification and would have been frozen into the record
format. F-8 and F-10 came from adversarial review #2 and are recorded in §6.

### F-1 — Inherited irreversible effects were absorbed as silent cache hits
**Found by:** `fork.test.ts`, "a fork may not silently redo a protected irreversible
effect".
**What happened.** A fork inherits its parent's effect index at the cut. On re-invoking
an identical irreversible effect (a payment), the kernel's dedup path matched *before*
the protection check and returned the parent's outcome as `completed`. The caller could
not distinguish "I charged the customer" from "an ancestor charged them before the cut".
**Why the specification missed it.** Both prose and code conflated two different
questions: *has this lineage done this?* (dedup — safe, silent) and *did an ancestor do
this before the cut?* (inheritance — unsafe for irreversible effects).
**Fix.** Effect-index entries carry an `inherited` flag set at fork time. Inherited
entries of unsafe classes refuse loudly with a journaled `policy.denied`; only an
explicit `allowReplayOfProtected` override (with a reason, journaled in the fork event)
permits replay. Silent dedup remains for lineage-local and safe-class effects.
**Now enforced by:** invariant I24; `fork.test.ts` ×3; differential fork-isolation test.

### F-2 — The authority mint guard was exported, so any module could forge a grant
**Found by:** `grants.test.ts`, "a grant handle cannot be forged".
**What happened.** `GrantHandle` was protected by a guard symbol — which the types module
exported. Any code that could `import { KERNEL_MINT }` could mint a valid handle for any
grant id read off a journal event. The implementation committed precisely the sin the
first adversarial review flagged in a competitor: *knowing a string is holding authority*.
**Fix.** Authority is now **object identity**: the kernel keeps a private `WeakSet` of
handles it minted and accepts nothing else. Construction with a known id, prototype
forgery, and shallow-copying a genuine handle are all rejected; the genuine object still
works.
**Now enforced by:** invariant I21; three forgery attacks in `grants.test.ts`.

### F-3 — Delegation computed child budgets from stale authority, and swallowed the refusal
**Found by:** `grants.test.ts`, recursion-bound test (via a debug trace showing recursion
stopping one level early with no journal record).
**What happened.** Two bugs compounding. The delegation path used a grant snapshot
captured *before* the parent's own reservation, so the computed child budget exceeded
true remaining and attenuation threw. That refusal was then caught and returned as a
generic failure — with nothing journaled. A delegation refused for lack of authority left
no trace at all.
**Fix.** Authority is re-read from current state at delegation time, and every refusal
commits `policy.denied` with its reason before returning.
**Now enforced by:** invariant I22; coverage guard requires ≥20 policy denials per run.

### F-4 — Checkpoints were durable but not recoverable
**Found by:** `universality.test.ts`, "heterogeneous capabilities survive checkpoint,
fork and recovery identically".
**What happened.** Checkpoints were written to durable storage but `recover()` never
reloaded them, so a restarted kernel could not fork from its own checkpoint — exactly the
disaster-recovery case checkpoints exist for.
**Fix.** Recovery reloads all durable checkpoints (discarding torn ones) before folding
the journal.
**Now enforced by:** the same test, plus crash-matrix row 10.

### F-5 — Staging leaked when a capability threw a crash-class error
**Found by:** `coverage.test.ts`, seed 8, operation 24 — invariant I16 violated.
**What happened.** The staging area was released on normal and error paths but not when a
provider threw a crash-class error, on the assumption that the process was dying anyway.
A capability can raise such an error without the process dying, leaving candidate effects
resident in a live kernel.
**Fix.** Staging is released on every exit path before rethrowing.
**Note.** This is the one falsification that only randomized testing found; no
hand-written scenario reached it.

### F-6 — Irreversible-effect protection did not survive a process restart
**Found by:** an attack script written while adversarial review #2 was running (the
author attacking the author's own fix).
**What happened.** The F-1 protection lived in two in-memory structures. Recovery
rebuilt the effect index with a hardcoded `effectClass: 'pure'` and never restored the
protected-effect set. After a restart, a fork taken from a fresh checkpoint reported
`completed / deduplicated` for an irreversible charge it had never performed — F-1
returning through the recovery door, invisible to every existing test because none
combined *restart* with *fork* on an irreversible effect.
**Fix.** Recovery rebuilds the true effect class from the committed `invocation.admitted`
record and re-derives `protectedEffects` from committed outcomes, including effects that
landed under an invocation that later failed (the world still saw them).
**Lesson recorded.** Any protection held in memory must be re-derivable from committed
evidence, or it is a protection that lasts until the next crash. This is now a review
question for every future kernel invariant.
**Now enforced by:** `fork.test.ts` — "irreversible-effect protection survives a process
restart".

### F-7 — Grant limits are ceilings, not reservations (specification gap, not a defect)
**Found by:** an attack script probing sibling delegation.
**What happened.** A parent holding 5 invocations can mint ten children each declaring 4
— sibling limits sum to 40. This looked like an authority hole. Investigation showed
actual spend is correctly bounded (40 attempts, 5 admitted, parent settled exactly 5),
because admission checks every grant in the chain. So the mechanism is sound but the
*documentation implied a guarantee it does not give*: developers would read a grant's
limit as reserved budget.
**Fix.** No code change. The semantics are now specified explicitly (doc 17 §9a) as thin
provisioning, with the real guarantee stated and tested.
**Why it is recorded as a finding.** A misunderstood guarantee is a defect in the
contract even when the code is right — and this one would have produced production
surprises of the form "my subagent had budget but was denied".

---

## 3. Specification changes forced by execution

Beyond the five defects, execution changed the design in three ways:

1. **`resume` and `fork` were separated into different verbs** (doc 17 §8). Phase-1's
   single `restore` could neither rewind nor reconcile, and the first review called the
   result incoherent. The resolution is that resume *continues* a lineage (snapshot +
   committed suffix, same identity) while fork *branches* it (state at the cut only, new
   identity). Post-cut isolation then falls out structurally, and the differential test
   confirms it across 21 seeds.
2. **Delegation needs no kernel handle.** The original contract implied that a delegating
   capability required kernel access. Generators solve it: a capability yields a
   `delegate` proposal and receives the outcome through `next()`, while the kernel
   attenuates authority for the child. This preserved the commit barrier without
   sacrificing composition — and made recursion bounded by authority rather than by a
   counter.
3. **Commit-phase policy stages now receive the capability identity.** They previously
   received an empty string, so a commit-phase stage could not identify what it was
   adjudicating.

---

## 4. What passed unchanged

Worth recording, because these were the load-bearing claims:

- **Universality survived the harder test.** Eight heterogeneous constructs (raw LLM,
  tool, MCP-shaped server, delegating coding agent, graph strategy, opaque A2A remote,
  human approver, local model) traverse one invocation path under real commit barriers,
  uncertainty, dedup, forks and grants — with the kernel naming none of them. The static
  gate runs in CI.
- **The structural commit barrier held against a deliberately malicious capability**,
  which found no kernel surface on its context and could not self-certify success past
  an evidence gate.
- **Journal-first recovery held at all 32 crash points**, including torn writes.
- **Budgets matched an independently-written reference model exactly** across 41 seeds.

---

## 5. Remaining risks

| Risk | Severity | Status |
|---|---|---|
| A capability that lies about its effect class defeats recovery triage | SERIOUS | Unsolved by design; mitigation is probes + telemetry, not structure. Documented in doc 19 §6. |
| Compensation can itself fail, leaving durable uncertainty | MODERATE | Represented honestly; no automatic resolution exists or is claimed. |
| One settlement must fit in one atomic commit record | MODERATE | Accepted constraint (doc 19 §2); needs a bound in the conformance profile before freeze. |
| The prototype's storage is in-memory-with-durable-semantics; real fsync/torn-page behaviour is modelled, not measured | MODERATE | Must be re-validated against a real storage backend in Wave 1. |
| Grant handles do not survive process restart (authority must be re-obtained) | MODERATE | Correct ocap behaviour, but the re-acquisition path is unspecified for long-running executions. **Open design question.** |
| Kernel-crossing cost is still unmeasured | SERIOUS | Unchanged from phase 1; the in-process prototype cannot answer it. Blocks the isolation wave, not the record format. |
| Single-execution ordering only; no cross-execution ordering guarantees | LOW | Deliberate (doc 17 §2); may surprise implementers expecting a global log. |

---

## 6. Findings from adversarial review #2 (2026-08-16)

Five specialist reviewers attacked the executable kernel with their own scripts. They
produced **17 FATAL, 34 SERIOUS and 9 MODERATE findings, 44 of which block the record
format freeze**. Full record: `research/ADVERSARIAL-REVIEW-2.md`; decision and blocker
taxonomy: `22-RECORD-FORMAT-FREEZE-DECISION.md`.

Two were fixed immediately during the review, because they were the same class as F-6 and
had working reproductions:

### F-8 — A forked lineage was not reconstructable from its own journal
**Found by:** the event-sourcing reviewer, with an end-to-end reproduction.
**What happened.** `recover()` rebuilds each execution from *its own* journal records. A
forked child's inherited state — cell, artifacts, effect index, protected effects, grants
— came exclusively from the checkpoint blob at fork time and was never written to the
child's journal. A restart therefore erased everything the fork inherited, and the same
irreversible charge executed twice **while `checkInvariants()` reported zero violations**.
The reviewer's framing is the important part: *for a forked lineage, the journal was not
the source of truth, and the record format had no way to say so.*
**Fix.** `fork()` now materializes inherited authority, effect identity and protected
effects into the child's own first commit (`grant.inherited`, `effects.inherited`), with an
attested snapshot reference and an inheritance digest.

### F-9 — Terminal failure records omitted effect identity
**Found by:** invariant I25 (added in response to F-8) on its first property run.
**What happened.** Commit-gate and policy-denial failures journaled no `effectKey`, so
those index entries could not be rebuilt after a restart.
**Fix.** Every terminal invocation record now carries `effectKey`, `effectClass` and
`landedExternal`.

### The invariant that was missing
Both F-6 and F-8 were instances of one class: **state held in memory that cannot be
re-derived from durable records**. Invariant **I25** now asserts that the live projection
equals the projection recovered from storage, sampled through the property suite and
asserted in the fork tests. It found F-9 within one run of being added.

**The remaining 42 blockers are catalogued, not fixed.** They are the specification for
the next phase (doc 22 §4), and the honest summary is that the *semantics* largely
survived while the *record format* did not.

### F-10 — The commit gate was not durable across suspension
**Found by:** the distributed-systems reviewer, with a reproduction.
**What happened.** `requiresEvidence` lived only in the per-call options. `resumeInvocation`
called settlement with empty options, so a capability could suspend on its first turn and
then, on resume, ship a production artifact alongside *failing* evidence and return
`status: 'ok'` — landing `completed` with the artifact promoted. The gate was also lost
across a restart, since the fold never restored it. Two lines of capability code defeated
the single most load-bearing claim in the design (doc 17 §4).
**Fix.** The gate is now a property of the durable invocation record, folded from
`invocation.admitted` and read at settlement rather than from the caller's options.
**Now enforced by:** `universality.test.ts` — "the commit gate survives suspension and
resume".

**Final tally for this phase: 10 findings, all fixed** (F-1…F-10). The remaining
**52 review findings are catalogued, not fixed** — see doc 22.

---

## 7. Findings from Wave S1 — record-format completion (2026-08-16)

Nine further falsifications, F-11 to F-19, produced while implementing and attacking the
`2026-08-17` record format. Full context: doc 25. Two of these (F-12, F-13) falsified a
decision made earlier **inside the same wave**, and two (F-18, F-19) were found by an
independent reference model rather than by any hand-written test.

### F-11 — The disk decided the record format's integrity recipe
**Found by:** reading `Storage.readJournal()` while writing the first S1 race test.
**What happened.** `readJournal()` hard-coded `checksum === sha(record.events)`, the
phase-2 recipe. The S1 format checksums the whole record, so **every S1 record verified as
torn**, and recovery silently saw an empty journal — a catastrophic failure that produced
no error at all. No test had run against S1 recovery yet, so nothing was red.
**Fix.** Which bytes a checksum covers is a record-format decision, not a disk decision.
The verifier is now supplied by the caller; storage keeps bytes.
**Now enforced by:** `s1-integrity` I7, which asserts the two formats are not confusable in
either direction.

### F-12 — Protection was scoped to the ancestor path, not the lineage tree
**Found by:** `s1-lineage` L1/L2, written against the real-world requirement rather than
against the implementation.
**What happened.** The first S1 implementation bound an execution only by effects landed by
itself and its ancestors, on the theory that siblings are divergent world-lines. The
record-format header called this asymmetry "the load-bearing decision of this wave". It is
wrong: **the external world is not forked.** A lineage tree is bookkeeping; a charged card
is a fact. B9a's ratified resolution had already specified lineage-tree scope "regardless
of which cut a child came from", and the implementation had narrowed it.
The narrowing also left two mechanisms answering one question differently — `protectionFor`
said a fork taken from before a charge was unbound, while the family-wide claim table
refused it anyway. The safer mechanism was winning by luck.
**Fix.** Protection is family-scoped. The ancestry walk and its visibility horizon are
deleted: one scope, one rule, fewer mechanisms. `protectionFor` no longer accepts an
execution id, because a signature that accepted one would imply the answer could depend
on it.
**Now enforced by:** `s1-lineage` (8 tests) and `s1-fork` F5/F6, which assert a cut taken
before a landing and one taken after give the same answer by the same mechanism.

### F-13 — An operator could assert away a durable landing
**Found by:** `s1-lineage` L3, written to remove the luck F-12 exposed.
**What happened.** Resolving an uncertain invocation `abandon-failed` deleted the claim even
when a durable `effect.landed` record existed. A fork then charged the card a second time —
reported by the test runner as "Missing expected rejection", i.e. an invocation that should
have been refused was admitted.
An operator may resolve an unknown **outcome** to failed. No operator can un-charge a card
the journal says was charged; the disagreement is about the outcome, and the record is
about the world.
**Fix.** The kernel refuses the disposition when a landing is recorded, and the fold
independently refuses to free a landed key — the fold is the authority and must hold
against a buggy or hostile writer.
**Now enforced by:** `s1-lineage` L3 and L3b, the latter synthesising exactly the forged
record the kernel now refuses to emit, plus `s1-security` A11.

### F-14 — The protection query ignored effect class
**Found by:** `s1-lineage` L5.
**What happened.** `protectionFor` reported any landed effect as protected, including
`external-idempotent`. Behaviour was accidentally correct because the caller re-checked
exclusivity, but the query itself was misleading — and the reference model and the
invariant checker would both have inherited the lie.
**Fix.** Only classes that cannot be safely repeated are protected.

### F-15 — Budget enforcement was opt-in
**Found by:** `s1-grants` G4b.
**What happened.** Reservations were built from the caller's `estimate` alone, so any unit
the caller declined to estimate was never reserved and therefore never settled. Token
budgets could be bypassed by not mentioning tokens — B9b in a new costume.
**Fix.** A capability's manifest declares the units it consumes with a per-invocation floor.
The reservation is the per-unit maximum of that floor and the caller's estimate; neither
side can shrink it.

### F-16 — Settlement rested on capability honesty
**Found by:** `s1-grants` G4c, reasoning from the pure-proposer principle.
**What happened.** Settlement charged capability-declared usage, so a capability declaring
zero could run forever against a finite budget. A safety property depended on untrusted
code, contradicting the stance the whole architecture rests on.
**Fix.** Units are declared `metered` or not. A metered unit is one where the provider
reports authoritative consumption, so a declaration below the reservation is believed and
the over-estimate refunded. An unmetered unit is charged its full reservation whatever the
capability claims.
**Residual limit, stated:** a metered unit is trusted downward. See doc 25 §7.

### F-17 — Redaction is not a single-event operation
**Found by:** `s1-integrity` I2 failing on its first run.
**What happened.** Redacting the event carrying a secret left the secret in the journal,
because `invocation.admitted` also carries the request — added in this wave so a suspended
invocation could be re-entered from a cold start. Erasure must find every event carrying
the datum.
**Fix.** None to the format; the finding is recorded and the cost pinned. The test asserts
the exact number of events carrying the datum, so a revision that adds another copy fails
and someone has to look at it. Carrying sensitive payloads by artifact reference is the
structural answer and was out of scope for this wave.

### F-18 — Usage evidence from a failed invocation was discarded
**Found by:** the independent reference model, seed 1 step 5.
**What happened.** Proposals were only read when the result was `ok`, so a capability that
consumed 5,000 tokens and then failed was charged nothing. A retry loop could spend without
limit for the price of one invocation unit per attempt.
**Fix.** `usage` and `evidence` are **observations** about what happened, not **outputs** of
a successful run, and are now read whatever the outcome. State and artifact writes are
outputs and are still discarded on failure.

### F-19 — A capability could claim it touched the world without the class to do so
**Found by:** the independent reference model, seed 3 step 25.
**What happened.** A capability declaring class `local` yielded
`{type: 'external', landed: true}`. The kernel recorded a landing, but protection keys off
the declared class and `local` is not exclusive, so the landing bound nothing and the same
external effect could be repeated freely.
**Fix.** The class is a negotiated manifest property fixed before the invocation; the
proposal is per-yield and untrusted. Where they disagree the manifest wins, and the
disagreement is journaled as `external-landing-from-non-external-class`.
**Now enforced by:** `s1-effects` E12.

### What this round says about method

F-12 is the uncomfortable one: the wave's own stated "load-bearing decision" was falsified
by tests written a few hours later, and the ratified resolution it departed from had been
correct all along. The narrowing survived because it was written down confidently in a file
header — which is exactly the mechanism by which architecture documents become wrong and
stay wrong.

F-18 and F-19 are the instructive pair. Both were reachable, both were security-relevant,
and neither was found by any of the 129 hand-written tests in this wave. They were found by
an independent model that shares no code with the implementation, because it was written
from the specification rather than from the code and could therefore disagree with it. A
model derived from the fold would have agreed by construction and proved nothing.
