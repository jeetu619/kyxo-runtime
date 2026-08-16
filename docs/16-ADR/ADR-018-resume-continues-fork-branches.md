# ADR-018 — Resume continues a lineage; fork branches it; effect identity is lineage-scoped

Status: **Accepted** (2026-08-16, phase 2). Amends ADR-002 (journal-first event sourcing
with checkpoint composite) and ADR-009 (durability by journal injection); ADR-002 remains
normative for recovery semantics and now incorporates this decision.

## Context

The first adversarial review's FATAL-1, from the distributed-systems reviewer, was that
the checkpoint composite, fork-from-checkpoint and journal-as-truth were *mutually
incoherent*, and that the phase-1 prototype had already hit it: replay rebuilt state past
the checkpoint, so `restore()` could validate but never rewind. The reviewer's precise
attack: fork from a cut while the parent journal extends past it, and nobody can say
which lineage's dedup state governs effect identity. Either the child re-executes effects
the world already saw, or it inherits outcomes produced after the cut under an abandoned
definition.

Amendment A1 adjudicated the direction (lineage-scoped identity, explicit dispositions)
and required an executable specification as a freeze gate. This ADR records what that
implementation established.

## Decision

**Resume and fork are different verbs with different identity semantics.**

1. `resume(checkpoint)` **continues** a lineage: same execution identity, state = snapshot
   at the cut **plus** the committed journal suffix after it. A checkpoint is a recovery
   accelerator, never a rewind. Resume MUST verify that folding the journal prefix
   reproduces the snapshot.
2. `fork(checkpoint, dispositions)` **branches** a lineage: new execution identity, first
   event `execution.forked` carrying parent, checkpoint and cut. State is the cut *only*;
   post-cut parent events are never inherited.
3. **Effect identity is lineage-scoped.** The child inherits index entries at the cut,
   each flagged `inherited`. The parent's post-cut effects are invisible, so the child may
   legitimately perform that work itself.
4. **Inherited unsafe effects refuse loudly.** An inherited `external-irreversible` or
   `external-compensatable` effect is never returned as a silent cache hit; replay
   requires an explicit `allowReplayOfProtected` override carrying a reason, journaled in
   the fork event.
5. **Every pending invocation at the cut requires an explicit disposition** — `adopt`,
   `re-lease` (safe classes only), `compensate` or `abandon`. Forking with an unaddressed
   pending fails loudly.
6. **Merge is unsupported**, explicitly and permanently at this layer. Divergent lineages
   have divergent world effects; reconciliation is ordinary work performed by a strategy
   in a third lineage, not an automatic kernel rule.

## Alternatives considered

**A. Fork by copying the parent's journal prefix into the child.** Rejected: it
duplicates history (storage cost proportional to fork count), and it makes the parent's
events appear to have happened *in the child*, corrupting attribution. Causal reference
to a cut carries the same information without the lie.

**B. Shared dedup state across lineages.** Rejected — this is the reviewer's exact
attack. If the child consults the parent's post-cut effect index, it inherits outcomes
produced under a definition it has abandoned; if it consults only the checkpoint's, but
the parent continues, the two lineages silently diverge on what "already done" means.
Lineage-scoping makes the divergence explicit and auditable.

**C. Rewind-in-place (mutate the lineage back to the cut).** Rejected outright: it
destroys committed history, which is the one thing the journal exists to prevent.

**D. Support merge.** Rejected for this layer. No rule can reconcile two lineages that
each performed external effects, and a merge that silently picks a winner would be the
most dangerous operation in the system.

## Consequences

**Positive.**
- The FATAL is resolved structurally rather than by convention: post-cut isolation is a
  property of *how the child is built*, verified differentially across 21 seeds.
- Fork became the safe repair verb A1 intended: dispositions force an operator to state
  what happened to in-flight work instead of the system guessing.
- Multiple and nested forks are independent for free.

**Negative (real, and accepted).**
- **Dispositions do not scale by hand.** An incident with hundreds of pending invocations
  requires a per-invocation decision. There is no bulk or default-policy story yet; the
  durable-execution reviewer is expected to press on this, and it is recorded as an open
  operational gap.
- **Two verbs are two chances to pick wrong.** An operator who forks when they meant to
  resume silently abandons the suffix. Tooling must make the distinction obvious.
- **No merge means branch proliferation** is the user's problem to manage.
- **Protection must be re-derivable from committed evidence.** The first implementation
  held it in memory and lost it across restart (doc 20 F-6). Any future in-memory
  protection is now suspect by default.

## Evidence and confidence

- EXECUTABLE (HIGH): `tests/fork.test.ts` (8 tests) covering cut isolation, parent
  immutability, protected refusal, explicit override, mandatory dispositions, sibling and
  nested independence, crash-during-fork, restart-survival, and the resume-vs-fork
  distinction; differential fork-isolation across 21 seeds; 374 forks exercised in the
  coverage run.
- Confidence **HIGH** on the semantics; **MEDIUM** on operational usability at scale
  (the disposition-ergonomics gap above).
