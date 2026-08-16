# ADR-026 — Budget units declare whether anyone measures them

Status: **Accepted** (2026-08-16, Wave S1). Resolves blocker B9b. Amends ADR-020's
authority model by extending it from *rights* to *accounting*.

---

## 1. Context

Amendment A2 established reserve-at-lease / settle-at-outcome. Wave S1 found two ways that
accounting still rested on the honesty of untrusted code:

- **F-15.** Reservations were built from the caller's `estimate` alone, so a unit the
  caller declined to estimate was never reserved and therefore never settled. Token
  budgets were bypassable by not mentioning tokens.
- **F-16.** Settlement charged capability-*declared* usage, so a capability declaring zero
  could run forever against a finite budget.

Both contradict the stance the architecture rests on: capabilities are untrusted proposers,
and no safety property may depend on their good behaviour (ADR-017).

But the naive fix — always charge the reservation — is wrong for the most important unit in
practice. An LLM capability cannot know its token consumption before the call; estimating
4,000 and consuming 500 would burn 4,000, and no real system accounts that way.

## 2. Decision

**A capability's manifest declares the budget units it consumes, and for each one declares
whether that unit is *metered*.**

```ts
interface UnitPolicy { perInvocation: number; metered: boolean }
```

- **Reservation** for a unit is the **maximum** of the manifest's `perInvocation` floor and
  the caller's estimate. Neither the caller nor the capability can shrink it, which is what
  makes enforcement non-optional.
- **`metered: true`** means the provider reports authoritative consumption — the authority
  that reports usage is the authority that bills for it. A declaration below the
  reservation is believed, so an over-estimate is refunded.
- **`metered: false`** means nobody measures the unit. The declaration is untrusted code's
  word about its own spending, so the full reservation is charged whatever it claims.
- A declaration **above** the reservation is capped and journaled as
  `usage-exceeds-reservation`.
- A non-completed invocation settles only evidenced usage, so retries do not eat the
  budget. Failures remain bounded because `invocations` is always reserved and always
  charged.

`metered` is a **declared, negotiated manifest property**, which is the kind of thing the
kernel is permitted to branch on — the same axis as effect class. It is not capability
identity and not a Kind.

## 3. The guarantee, stated exactly

The kernel guarantees: **no invocation is admitted unless the family's ledger has room for
its reservation.** That is enforceable without trusting anyone.

The kernel does **not** guarantee that a settled figure reflects reality for a metered
unit. A capability that lies downward about a metered unit under-charges the ledger. No
kernel that cannot itself measure tokens can promise more, and pretending otherwise would
be the kind of claim doc 22 criterion 11 exists to catch.

## 4. A related decision: unmentioned units have capacity zero

A unit that no grant in the chain mentions has capacity **zero, not unlimited**. A grant
enumerates the authority it confers, exactly as it does for rights. The practical effect is
that adding a unit to a capability's manifest makes previously-issued grants insufficient
rather than silently unlimited — it fails closed.

## 5. Alternatives considered

**Always charge the reservation.** Rejected: correct for safety, useless for token
accounting, and would push every caller toward under-estimating, which reintroduces F-15
from the other side.

**Trust declarations universally.** Rejected: that is F-16.

**Kernel-side measurement.** Out of scope and mostly impossible — the kernel does not sit
between the capability and the provider. Where a future binding *does* (a proxying gateway),
that binding becomes the meter and the unit's `metered` flag becomes true on evidence
rather than on assertion. The declaration point is designed to accommodate that.

## 6. Consequences

**Positive.** Budget enforcement no longer depends on capability honesty for the
admission-time guarantee. Over-estimation is refundable where it can be verified. The trust
boundary is explicit in the manifest rather than implicit in the implementation.

**Negative.** Capability authors now have a security-relevant field to get right, and
declaring a unit `metered` when nothing meters it silently weakens accounting. This is a
review obligation on manifests, and it is not currently checked by anything.

## 7. Evidence

`s1-grants.test.ts` G4–G4d and G5–G7. G4d deliberately asserts the residual limit — a
capability lying downward about a metered unit under-charges — so the boundary is pinned by
a passing test rather than described in prose.

Confidence: **HIGH** for the admission-time guarantee. **MEDIUM** for accounting accuracy,
bounded by provider honesty.
