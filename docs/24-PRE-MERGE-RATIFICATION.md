# 24 — Pre-Merge Ratification

Date: 2026-08-16. Purpose: state exactly what merging this branch to `main` makes
authoritative, and — equally important — what it does not.

# Recommendation: **READY TO MERGE TO MAIN AS ARCHITECTURAL BASELINE**

---

## 1. What this merge establishes

`main` becomes the authoritative **research, architecture, decision and semantic-reference
baseline** for Kyxo Runtime: 13 ecosystem research notes, 24 architecture documents, 23
ADRs, two adversarial review records, and an executable semantic reference with 46 passing
tests.

### What this merge does NOT mean

| Not implied | Actual status |
|---|---|
| Record format frozen | **NOT FROZEN** — 52 blocking findings (doc 22) |
| Kernel ABI frozen | Does not exist yet |
| Public SDK / protocol frozen | Not designed; deliberately deferred until the format freezes |
| Provider API frozen | Not designed |
| Production implementation approved | Not started; Wave S1 is next |
| All Proposed ADRs promoted to Accepted | **No** — see §3; eight remain Proposed |
| Compatibility owed forever from this commit | No — nothing here is a compatibility surface |
| Wave S1 complete | Not begun |

**Architecture ratified ≠ record format frozen.** These are separate gates, and only the
first is passed.

## 2. Precedence rule (authoritative)

When two artifacts disagree, the higher wins:

```text
1. Executable evidence            prototypes/kernel-semantics/ + its passing tests
2. Accepted ADRs (017–023)        and binding amendments A1–A14
3. Normative specifications       docs 17, 18, 19
4. Current architecture docs      docs 21, 22, 23, and 20 as the evidence record
5. Pre-review architecture        docs 01–16 (each carries a status banner)
6. Research synthesis             docs 02, 03
7. Historical research notes      research/notes/ — never edited to match later decisions
```

Two clarifications this rule settles:

- **ADRs 001–016 outrank docs 01–16** where they conflict, because an ADR records a
  decision while a document explains one — but both are outranked by A1–A14 and by
  ADRs 017–023, which were forced by evidence those documents predate.
- **Prototypes outrank prose about behaviour, never about intent.** Where the code
  contradicts a normative claim, the code is the finding and the document is corrected —
  that is how all ten F-findings arose. Prototype code is *not* authoritative about what
  the production runtime should be (`prototypes/README.md`).

Superseded material is retained and marked, never deleted: decision provenance is part of
the baseline.

## 3. Decision ratification matrix

**RATIFIED** — baseline, supported by executable evidence, may later be superseded by ADR:

| Decision | Source | Evidence | Implementation may rely on it |
|---|---|---|---|
| Agent is not a kernel primitive | ADR-001 | Universality suite; no capability-identity branching in kernel (I1, CI-enforced) | **YES** |
| Graph is an orchestration strategy, not kernel topology | ADR-004 | Phase-1 graph prototype; kernel contains no graph concept | **YES** |
| Harness is a behaviour contract and a capability | ADR-005 | Two harnesses, set-identical at the kernel boundary | **YES** |
| Delegation is invocation under attenuated grants | ADR-015 | Recursion bounded by authority; self-delegating capability terminates | **YES** |
| Capabilities are pure proposers; commit barrier is structural | ADR-017 | Malicious capability reaches no kernel surface; cannot self-certify (I3, I4, I17) | **YES** |
| Resume continues a lineage; fork branches one | ADR-018 | Fork suite (9 tests); differential fork isolation | **YES — semantics**; record shape blocked |
| Unknown external outcomes are explicit, never guessed | ADR-019 | Crash suite: landed-but-unrecorded ⇒ `uncertain`, never auto-retried | **YES** |
| Authority is object identity, not a string | ADR-020 | Three forgery attacks rejected (I21) | **YES** |
| Kyxo Runtime is independently usable; Platform and Code are consumers | ADR-022 | Zero product/IDE/provider names in kernel sources; four boundary tests pass | **YES** |
| Coding engine is IDE-independent; IDEs are clients | ADR-023 | Architectural, backed by four-system convergence | **YES** |
| BUILD WITH CHANGES | ADR-021, doc 01 | Ten defects, all in the record/lifecycle layer a host framework owns | **YES** |

**ACCEPTED AS AMENDED** — decision stands; mechanism has changed and remains partly open:

| Decision | Amended by | Still open |
|---|---|---|
| Journal-first durability with checkpoint composite (ADR-002, ADR-009) | A1; ADR-018 | Record shape (B1–B4) |
| Verification commit gate (ADR-012) | ADR-017 replaced its *enforcement*; F-10 made it durable | Gate spec in `Checkpoint.pending` |
| Budgets as attenuated quantitative grants (ADR-014) | A2 reserve/settle | Lineage across forks (B2); non-`invocations` units (B9b) |
| Object-capability security (ADR-013) | A8, ADR-020 | Taint propagation unimplemented (B8); cross-restart authority |
| TypeScript reference kernel, protocol-first (ADR-010) | A4 | Facade re-specification after ADR-017 shrank it |

**PROPOSED — not promoted by this merge** (ADR-003, 006, 007, 008, 011, 016, and the
harness-selection contract A13/A14): they stand as the intended direction but have no
executable confirmation. A future contributor may reopen any of them without an ADR
supersession ceremony.

**BLOCKED / NOT FROZEN** — direction exists, representation unresolved: effect-claim record
shape; lineage-scoped protection ledger; lineage-scoped grant representation; schema
migration and upcasting; payload hashing and redaction; record integrity verification;
time, deadline and lease representation; remote authority representation; concurrency and
single-writer semantics; the exact persisted field set. All ten map to doc 22 §2.

**SUPERSEDED** — discoverable, never current: the phase-1 provider contract that handed
capabilities a live kernel handle (superseded by ADR-017); decrement-at-commit budget
accounting (superseded by A2); "restore" as a single verb conflating resume and fork
(superseded by ADR-018); the exported mint guard (superseded by ADR-020).

**DEFERRED** — deliberately not decided now: package names and repository restructuring;
`AxisRequirement` → `AxisConstraint` (the type exists only in a disposable phase-1
prototype; renaming it now is churn, and the production record format has yet to be
written); `docs/16-ADR/` → `docs/adr/`; the Code Client Protocol; context/memory/
verification/observability packages.

## 4. Validation evidence (clean state, this commit)

```text
npm ci                                        OK
npx tsc --noEmit                              PASS (TypeScript strict, zero deps)
node --test kernel-semantics/tests/*.test.ts  46 tests / 46 pass / 0 fail
bash kernel/validate.sh                       ALL GATES PASS (phase-1 universality)
fuzz: 1000 seeds × 70 ops                     70,000 operations, clean
```

Per full test run: ~9,300 invariant evaluations, 32 crash-point recoveries (clean and torn
writes), differential agreement with an independent reference model. CI
(`.github/workflows/kernel-semantics.yml`) runs typecheck, the invariant gate, the full
semantic suite and the phase-1 gates on every push; the extended fuzz runs on schedule.

## 5. Consistency corrections made in this pass

| Correction | Was | Now |
|---|---|---|
| Doc 20 suite table | 39 tests; `evolution.test.ts` missing; fork 8, universality 5 | 46 tests; evolution row added; fork 9, universality 6 |
| Doc 20 falsification count | "Seven findings" | Ten (F-1…F-10) |
| Doc 22 test count (2 places) | 45 | 46 (the historical sentence keeps "at the time") |
| Doc 22 blocker count | "44 findings are the specification" | 52 |
| Doc 22 fork/universality rows | 8 / "Eight constructs" | 9 / 6 tests |
| ADR index | "twenty-one ADRs"; 44 blockers | twenty-three; 52 |
| **Doc 18 — invariant I25 was undocumented** | Implemented in code and cited by docs 20/22, absent from the invariants document | Full entry added; "four invariants added" → five |
| Doc 11 | 24,000 fuzz ops; "Seven findings" | 70,000; ten |
| README | ADRs "001-021"; five reviewers; 44 blockers; nine defects | 001-023; six; 52; ten |
| ADR statuses | Determinable only by opening 23 files | Authoritative status register in the ADR index |

Historical records keep historically accurate numbers: `research/ADVERSARIAL-REVIEW.md`
(121 findings) and `ADVERSARIAL-REVIEW-2.md` (22 FATAL / 40 SERIOUS / 10 MODERATE / 52
blocking) are verbatim review records and were not rewritten.

## 6. Known blockers

**52 freeze-blocking findings**, authoritative in `docs/22-RECORD-FORMAT-FREEZE-DECISION.md`
§2, clustered into ten workstreams (B1–B9b). Verified during this pass: no blocker is
described as resolved anywhere, none disappeared during reconciliation, and each cluster
maps to a wave in doc 22 §4. Ten defects **were** fixed during phase 2 (F-1…F-10, doc 20)
and are recorded as fixed; the 52 are separate and remain open.

## 7. Next phase

**Wave S1 — record-format completion.** B1 (admission-time effect claims), B2
(lineage-scoped grant ledger), B3 (landed external effects committed at yield), B4 (single
fold for derived state) and B8 (`payloadHash`; implement or retract `leaseEpoch`) land
**together**, because each adds or moves fields and a partial freeze guarantees a breaking
change. Not started, and not authorized by this merge.

## 8. Perspective check

| Reader | Could they tell authoritative from experimental, accepted from unresolved? |
|---|---|
| Future runtime maintainer | **Yes** — precedence rule (§2), status register (ADR index), `prototypes/README.md` |
| Distributed-systems engineer | **Yes** — doc 22 names what is unsound with reproductions; nothing claims soundness it lacks |
| SDK/API maintainer | **Yes** — §1 states no surface is frozen; doc 23 §9 layers stability |
| Security engineer | **Yes** — ocap ratified, taint explicitly unimplemented, guarantee boundary stated |
| Third-party developer, first visit | **Yes** — README states what the runtime is, that it is independently usable, and that the format is not frozen |

No serious NO. The merge proceeds.
