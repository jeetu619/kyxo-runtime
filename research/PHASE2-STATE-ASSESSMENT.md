# Phase 2 — Internal state assessment (pre-implementation)

Source of truth: the repository at commit `b439d27`, not the prior phase's summary.

## What exists

| Artifact | State |
|---|---|
| `research/notes/` (13) | Complete, labeled, source-ledgered. No action. |
| `research/DESIGN-SPINE.md` | Decisions + binding Amendment log A1–A14. Authoritative. |
| `research/ADVERSARIAL-REVIEW.md` | 121 findings (7 FATAL, 49 SERIOUS). Unanimous BUILD WITH CHANGES. |
| `docs/01` | Written post-review; reflects amendments. |
| `docs/02–15`, `docs/16-ADR/*` (16 ADRs) | Pre-review bodies; each carries a status banner naming applied vs outstanding amendments. |
| `prototypes/kernel,harness,graph,loop` | Phase-1 demonstrations. Type-clean, demos green. |

## Findings that remain semantically unresolved (this phase's targets)

1. **Commit barrier is voluntary** (prototype finding, CTO FATAL). `InvokeCtx.kernel` hands every
   provider a live `KernelApi` with `storeArtifact`, `bind`, `invoke`. A capability can produce
   durable artifacts without any outcome commit, and a strategy can yield a result without ever
   invoking a verifier. The gate is convention. **Structural fix required, not a policy stage.**
2. **Fork is unimplemented and its semantics are incoherent** (distsys FATAL). No `fork()` exists.
   `restore()` cannot rewind because journal replay rebuilds past the cut. Dedup-state ownership
   across a fork with a non-empty parent suffix is undefined.
3. **External-effect uncertainty has no representation.** The lifecycle has no state for "the
   effect may have happened; we crashed before recording." Auto-retry of a non-idempotent effect
   is currently indistinguishable from correct recovery.
4. **Dedup conflates six distinct mechanisms** and swallows audit evidence: CAS content dedup
   suppresses the `artifact.stored` journal record (observed in the loop prototype), and the
   dedup window is unbounded ("forever"), which is what made graph delta-execution look free.
5. **Grants are string-resolved** (security FATAL, amendment A8). `getGrant(id: string)` against a
   global table = knowing a string is holding authority.
6. **Reserve/settle (A2) is specified in the amendment log but has no implementation.**
7. **Cancellation requests are not journaled** — only honored transitions (prototype finding).
8. **No capability trait system.** Streaming/resumable/idempotent/reversible are undeclared, so the
   kernel cannot make effect-class decisions without knowing what a capability *is* — the exact
   pressure that produces type branching.

## Consequence for this phase

The phase-1 kernel prototype cannot be patched into a semantic reference: its provider contract
(`ctx.kernel`) is the bypass. This phase builds a **new, separate** semantic kernel under
`prototypes/kernel-semantics/` where capabilities are pure proposers, and keeps the phase-1
prototypes as the universality/harness/graph/loop demonstrations they were.

Editorial reconciliation of A1–A14 across docs 02–15 remains outstanding and is tracked
separately (secondary to executable semantics, required before freeze).
