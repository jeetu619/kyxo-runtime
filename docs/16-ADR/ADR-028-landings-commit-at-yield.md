# ADR-028 — A landed external effect commits at yield, and suspension is a lease that can be resumed

Status: **Accepted** (2026-08-16, Wave S1). Resolves blockers B3 and B5. Amends ADR-017
(pure proposers) by fixing *when* one particular proposal becomes truth, and ADR-018 by
giving resume a real implementation.

---

## 1. Context

Under ADR-017 a capability proposes and the kernel commits, and nothing a capability yields
is durable until settlement. That is right for artifacts, state and usage: they are the
invocation's **outputs**, and an invocation that fails should not leave them behind.

It is wrong for one proposal type. `{type: 'external', landed: true}` is not an output. It
is a **report that the world has already changed** — the capability has called the API; the
card is charged; the email is sent. Holding that as a candidate until settlement meant a
suspension, a crash or a thrown exception discarded it, and the journal then asserted that
something which really happened never happened.

Separately (B5), `resumeInvocation` was a second settlement path that re-implemented
admission badly: no authority chain check, no policy, no reservation, and no staging release
on error.

## 2. Decision

**A landing commits at the moment it is yielded.** From then on it is durable truth and
nothing downstream retracts it — not a suspension, not a failure, not an exception, not a
crash.

**Suspension is a retained lease, and `resume()` picks it up rather than re-admitting.**
Re-running admission would either be refused by the invocation's own claim or double-charge
the ledger, so resume does neither: it reads the reservation and the original request from
the **journal** and re-enters the capability with `ctx.resume` set. `invoke` and `resume`
share one runner and one settlement path, which is what B5 asked for.

The per-invocation reservation and the original request are therefore part of the record
format. Re-entry that depends on process memory is re-entry that stops working at the first
restart (I25).

## 3. A related decision: the class governs what may be claimed

A capability may only report a landing if its **declared effect class is external**. A
capability declaring `local` and yielding `{external, landed: true}` had its landing
recorded, but protection keys off the class, and `local` is not exclusive — so the landing
bound nothing and the effect could be repeated freely (F-19, found by differential testing).

The class is a negotiated manifest property fixed before the invocation; the proposal is
per-yield and untrusted. Where they disagree the manifest wins, and the disagreement is
journaled.

## 4. The limit this design cannot remove

**A capability re-entered after suspension re-runs its body.** If it ignores `ctx.resume`
and calls the API again, the world is touched twice, and no kernel that does not sit between
the capability and the network can prevent it.

What the kernel guarantees is that its own records stay coherent: the second yield is
recorded as a duplicate, the ledger keeps exactly one landing for the key, and protection is
unaffected. The obligation to consult `ctx.resume` lives in the capability contract.

`s1-effects` E7 pins this with a deliberately badly-behaved capability and asserts the world
was touched **twice** — the test states the limit rather than arranging for the attack not
to be attempted.

## 5. Alternatives considered

**Forbid suspension after a landing.** Structurally safe, and rejected: "charge the card,
then wait for human approval before the next step" is a real and reasonable pattern, and
forbidding it would push implementers into splitting one invocation into two, which loses
the very lease that makes the effect safe.

**Make resume replay a recorded proposal stream instead of re-running the body.** Rejected
for this wave: it would make the capability contract a replayable log rather than a
generator, which is a much larger change to ADR-017 than B3 justifies. Worth revisiting if
E7's limit proves costly in practice.

## 6. Consequences

**Positive.** No exit path from an invocation loses a landing. Suspension is no longer a
one-way door that holds a claim and a reservation forever. One settlement path, so a fix to
settlement cannot miss a caller.

**Negative.** The record format now carries the request in `invocation.admitted`, which
enlarges the redaction surface (ADR-027 §3). That is a real cost of making re-entry
journal-sufficient, and it is recorded rather than absorbed.

## 7. Evidence

`s1-effects.test.ts` — 12 tests. E1–E4 take a landing through suspension, a thrown
exception, a declared failure and a crash between yield and outcome. E5–E8 cover resume,
cold-start resume, the badly-behaved capability, and refusal to re-enter anything that is
not suspended. E12 covers the class/proposal disagreement. Crash positions 8–11 in
`s1-crash.test.ts` cover the same ground from the durability side.

Confidence: **HIGH** for the record semantics. The residual world-level risk in §4 is a
capability-contract obligation and is **not** a kernel guarantee.
