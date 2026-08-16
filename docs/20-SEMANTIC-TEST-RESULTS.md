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
KYXO_FUZZ_SEEDS=400 KYXO_FUZZ_LENGTH=60 node --experimental-strip-types kernel-semantics/fuzz.ts
```

---

## 1. Suites and scale

| Suite | Tests | What it establishes |
|---|---|---|
| `crash.test.ts` | 6 | Systematic crash sweep (16 write points × clean/torn = 32 recoveries) + landed-but-unrecorded effects, unknown probes, compensation, safe re-lease, checkpoint consistency |
| `fork.test.ts` | 7 | Cut isolation, parent immutability, protected-effect refusal, explicit override, mandatory dispositions, sibling and nested independence, crash-during-fork, resume-vs-fork distinction |
| `dedup.test.ts` | 5 | Six mechanisms kept distinct; CAS dedup preserves per-producer provenance; content-inclusive effect keys; budget not double-charged |
| `grants.test.ts` | 10 | Handle forgery (3 attacks), attenuation limits, lineage accounting, admission denial, transitive revocation, expiry, fork-vs-revocation, delegation attenuation, two recursion bounds |
| `universality.test.ts` | 5 | Eight heterogeneous constructs on one path, static no-type-branching gate, malicious capability containment, deny-class policy, mixed-class checkpoint/fork/recovery |
| `property.test.ts` | 3 | 120 seeded sequences × 40 ops with per-operation invariant assertion and a delta-debugging minimizer; differential agreement with the reference model on outcomes, budgets and fork isolation |
| `coverage.test.ts` | 1 | 150 seeds × 30 ops with a distribution guard that fails if interesting states stop being reached |
| **Total** | **37** | all passing; TypeScript strict, zero runtime dependencies |

**Volume per full run:** 4,500 coverage operations + 4,800 property operations + 32
crash-point recoveries, with a complete invariant check after **every** operation
(9,300 invariant evaluations). Extended fuzz adds 24,000 operations over 400 seeds
(58 s wall-clock).

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

Five defects were found by execution. Each was a *design* error, not a typo — four of
them existed in the written specification and would have been frozen into the record
format.

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
