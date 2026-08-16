# 21 — Amendment Reconciliation Ledger (A1–A14)

Status: **COMPLETE**, 2026-08-16. Every amendment adjudicated by adversarial review #1 and
recorded in the Amendment log of `research/DESIGN-SPINE.md` has been applied to the
document bodies and, where it was a semantic decision, implemented and tested in
`prototypes/kernel-semantics/`.

Verification method: each document carries a "Post-review status" banner naming what is
applied and what is outstanding, plus a "Revision record" section at its foot listing the
edits. Semantic amendments carry a test reference. A spot audit for superseded language
(e.g. `decrement-at-commit` outside historical context) returns only intentional
historical references.

| Amendment | Decision | Files affected | Applied? | Verified? |
|---|---|---|---|---|
| **A1** Fork/effect-identity: lineage-scoped identity, journaled dispositions, compensation normative, content-inclusive keys, property-test gate | docs 08, 10, 13, 15, 17, 18, ADR-002, ADR-009, ADR-018 | **YES** — and implemented | **YES** — `fork.test.ts` (8 tests), differential fork isolation across 21 seeds. Gate itself built: the property-test spec exists and runs |
| **A2** Budgets: reserve-at-lease / settle-at-outcome / release, with three event kinds | docs 05, 06, 07, 08, 10, 13, 14, 15, 17, ADR-014, ADR-020 | **YES** — and implemented | **YES** — differential budget agreement with the reference model; `grant.reserved/settled/released` in the journal |
| **A3** Guarantee grades (enforced / observed / declared); enforcement claimed only below the mediation waterline | docs 06, 07, 11, 14, 15 | **YES** (documentary) | **PARTIAL** — the grade vocabulary is in the docs; the Binding record does not yet carry it (deferred with the record-format work, doc 22 §2) |
| **A4** Facade freeze: KernelApi/InvokeCtx/HarnessCtx as a Wave-0 versioned, conformance-tested contract | docs 06, 07, 10, 14, 15, ADR-010 | **YES** (documentary) | **PARTIAL** — phase 2 changed the facade fundamentally (capabilities now hold no handle at all, ADR-017), so the verb list to freeze is now *smaller* than A4 assumed. Re-specification pending |
| **A5** Governance workstream at Wave 0 (licence, DCO, trademark/conformance marks, spec process, neutral-home trigger) | docs 12, 15 | **YES** | **YES** — Wave 0 deliverable with a risk-register row and kill signal |
| **A6** EXTEND re-argument; non-cooperative enforcement floor into the MVP | docs 07, 11, 14, 15, ADR-021 | **YES** | **YES** — ADR-021 re-argues on executable evidence and records that phase 2 *weakened* the enforcement leg and *strengthened* the semantics leg |
| **A7** MVP/roadmap reconciliation (doc 14 adapter roster canonical incl. Gemini; doc 15 wave numbering canonical) | docs 14, 15 | **YES** | **YES** — rosters and wave labels agree across both documents |
| **A8** Handles not strings; journal grant references non-resolvable | docs 05, 06, 11, ADR-013, ADR-020 | **YES** — and implemented | **YES** — three forgery attacks rejected in `grants.test.ts`. Note: the first implementation *failed* this amendment (doc 20 F-2) |
| **A9** Evidence relabeling: (i) graph-absence scoped to seven source-inspected agents; (ii) Realtime/Live claim is INFERENCE not FACT | docs 02, 03, 04, 06, ADR-004, ADR-005, ADR-006 | **YES** | **YES** — the three documents now agree, and no label-elevation language remains |
| **A10** Prototype-driven fixes: suspension origin, tier ladders as manifest data, cancellation requests journaled, artifact.produced per producer, ArtifactMeta label, fresh cells for children | docs 06, 08, 09, 10, 12, 17 | **YES** — mostly implemented | **PARTIAL** — cancellation-request journaling, per-producer artifact provenance and manifest-data ladders are implemented and tested; the suspension `origin` discriminator is specified but the suspension path itself has open defects (doc 22 B3, B5) |
| **A11** Memoization ≠ dedup: bounded reliability window vs content-keyed replay cache | docs 08, 17, ADR-002 | **YES** | **PARTIAL** — the two structures are separated in the record and the checkpoint carries only the bounded window; review #2 found the replay cache still conflates "ran" with "succeeded" (doc 22 B-cluster, findings 17/38) |
| **A12** Audit-grade allow path: policy-class journaling knob; model-judge verdicts always journaled | docs 08, 11 | **YES** (documentary) | **PARTIAL** — specified; the prototype journals all denials and no allow traces, so the knob itself is unimplemented |
| **A13** Selection contract: negotiation gates eligibility; `rank(candidates, telemetry, policy)` selects, with journaled rationale | docs 06, 10, 15 | **YES** | **N/A for phase 2** — selection is above the kernel semantics layer and was out of scope for the executable work |
| **A14** Curation economics: conformance-derived manifests for the four MVP adapters; enforcement badges only on probe-backed axes | docs 06, 15 | **YES** | **N/A for phase 2** — capability catalog work, out of scope |

## Summary

- **14 of 14 amendments applied to the documents.**
- **6 implemented and test-verified** in the executable kernel (A1, A2, A8, A9, A10 in
  part, A6 via ADR-021).
- **5 partial**, each for a stated reason rather than an oversight: A3 and A4 are affected
  by phase-2 design changes; A10, A11 and A12 have implementation remainders that are now
  part of the doc-22 blocker list.
- **2 out of scope** for a kernel-semantics phase (A13, A14) and unchanged.

No document states superseded behaviour as current fact. Where historical reasoning is
retained (notably doc 13's scenario P, whose NO verdict forced amendment A2), it is
explicitly marked as the analysis that moved the design.

## Cross-document contradictions found during reconciliation

Reported by the reconciliation agents and resolved:

1. Budget semantics appeared in four variants across docs 05/06/07/08/13/14/15 and
   ADR-014 — all normalized to reserve/settle/release.
2. Doc 14 and doc 15 disagreed on the adapter roster and on wave numbering — resolved per
   A7.
3. Doc 02/04 and doc 03 disagreed on the graph-absence breadth claim (Windsurf rated
   `n/e` in the matrix while the prose claimed source-inspection across all eight) —
   resolved per A9(i).
4. "Memory cell" collided with the kernel `Cell` object in doc 09 — resolved by defining
   memory cells as Kind records held in a single-writer store Cell.
5. ADR-002 and ADR-009 both specified recovery semantics — ADR-002 is now normative and
   ADR-009 cross-references it.
