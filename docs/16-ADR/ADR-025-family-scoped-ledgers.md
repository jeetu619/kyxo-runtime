# ADR-025 — Protected effects and grant budgets are both family-scoped ledgers

Status: **Accepted** (2026-08-16, Wave S1). Resolves blockers B2 and B9a. Supersedes the
per-execution grant copies in ADR-002's fork semantics and the checkpoint-snapshot
`protectedEffects` list. **Supersedes the ancestor-path scoping proposed and falsified
within Wave S1 itself** (doc 20 F-12).

---

## 1. Context

A *family* is a lineage tree: a root execution and every execution forked from it,
transitively. Two kinds of durable truth have to be scoped to something, and the phase-2
format scoped both wrongly:

- **Budgets** were copied into each child at fork, so every fork received a fresh copy of
  the remaining budget. Forking minted spending power — the cheapest possible privilege
  escalation, found independently by five reviewers.
- **Protected effects** were a point-in-time list captured at a checkpoint cut, so a fork
  taken from *before* an irreversible effect simply did not know about it and re-applied
  it. Reproduced: two real charges, zero invariant violations.

## 2. The decision, and the argument that decides it

**Both ledgers are FAMILY-scoped. An exclusive effect landed anywhere in the lineage tree
binds the whole tree; a unit of budget spent anywhere is spent for the whole tree.**

Wave S1 first implemented protection as **ancestor-path**-scoped — an execution bound by
its own and its ancestors' landings, but not by a sibling's — reasoning that siblings are
divergent world-lines and A charging a card does not mean B charged it. The record-format
header called this asymmetry the load-bearing decision of the wave.

It is wrong, and the argument that settles it is one sentence: **the external world is not
forked.** A lineage tree is a bookkeeping structure the runtime invented. A charged card is
a fact about a shared world that has never heard of lineages. If branch A really charged the
card and branch B charges it again, a real customer is charged twice, and no statement about
divergent world-lines makes that acceptable.

The legitimate use case behind the asymmetry — "I want branch B to be able to act
independently" — is served by **authority and binding**, not by lineage topology. A branch
that should act against a different world is bound to a different target, which changes the
request and therefore the effect identity. Keying world-facts on topology is a category
error.

## 3. Consequences of the reversal

The ancestry walk and its visibility horizon are **deleted**. `protectionFor(fam, key)` no
longer accepts an execution id, because a signature that accepted one would imply the
answer could depend on it. One scope, one rule, fewer mechanisms — which is also the
Liedtke-minimality answer.

A second defect fell out of the same reversal (F-13): with two mechanisms answering one
question differently, the safer one had been winning by luck. Removing the luck exposed a
path where an operator's `abandon-failed` deleted a claim whose effect had a durable
landing record, and a fork then charged again. Fixed at the kernel (the disposition is
refused) and independently in the fold (a landed key is never freed), because the fold is
the authority and must hold against a buggy or hostile writer.

## 4. What is deliberately NOT provided

**`allowReplayOfProtected`.** The phase-2 `ForkOptions` type declares an explicit,
journaled override for deliberately repeating a protected effect. It is **not implemented**
in the S1 kernel: every protected effect is unconditionally refused. This is stated rather
than quietly omitted, because "there is an escape hatch" and "there is no escape hatch" are
very different designs, and the type currently promises the former.

## 5. Alternatives considered

**Fork mints fresh attenuated grants** (doc 22's alternative resolution for B2). Rejected:
it makes forking an authority-granting operation, so the question "who authorised this
spend" gains a new answer for every fork. One ledger keyed by grant id keeps the answer
singular.

**Protection as a checkpoint floor.** Rejected as the primary mechanism for the reason B9a
gives: a floor over a snapshot still cannot see effects that landed after the cut a child
came from.

## 6. Consequences

**Positive.** No fork resets or multiplies authority; no fork escapes a landing; revocation
crosses forks; both ledgers are folds over committed records, so both survive restart (I25).

**Negative.** Genuine "simulate this branch independently" workflows have no kernel-level
support and must be expressed as different bindings. Cross-*family* duplicates are not
deduplicated at all — two unrelated runs charging the same card is a real-world concern
answered by caller-supplied idempotency keys, not by kernel state shared across runs.

## 7. Evidence

`s1-lineage.test.ts` (8), `s1-fork.test.ts` (12), `s1-grants.test.ts` (16). Notably F5/F6,
which assert that a cut taken before a landing and a cut taken after give the same answer by
the same mechanism, and F10, where five siblings compete for one effect and one budget.

Confidence: **HIGH**.
