# ADR-019 — Unknown external outcomes are an explicit lifecycle state, resolved only by disposition

Status: **Accepted** (2026-08-16, phase 2). New decision; extends the invocation
lifecycle of ADR-002/ADR-009 and doc 17 §6.

## Context

The phase-1 lifecycle had no state for the most consequential distributed-systems
failure in an AI runtime: *the external effect may have happened, and we crashed before
recording it*. A payment was dispatched; the process died; on restart the kernel sees an
invocation in `dispatched` and nothing else.

Every available default is wrong. Retry may double-charge. Marking it failed loses real
work and corrupts accounting. Marking it completed invents a result. Existing systems
mostly do not have an answer either: the durable-execution research found that all three
mature engines define success as "no exception" and none has a verification or in-doubt
concept above retry policy (`research/notes/durable-execution.md`), and A2A's task
lifecycle has no in-doubt state at all.

## Decision

**`uncertain` is a first-class, durable invocation state, and the kernel never leaves it
by inference.**

1. For external effect classes the kernel commits an **intent record** before invoking
   the provider. Without that record, a landed effect is indistinguishable from one that
   never started; with it, uncertainty is *detectable*.
2. On recovery, an invocation in `dispatched` with no outcome is triaged **by declared
   effect class**: `pure`, `local` and `external-idempotent` are safely re-leasable;
   `external-compensatable` and `external-irreversible` become `uncertain`.
3. `uncertain` is resolved only by an explicit, journaled disposition: `probe` (requires
   the `probeable` trait), `adopt-landed` (requires a recorded authority), `compensate`
   (requires the `compensatable` trait), or `abandon-failed` (requires a recorded
   authority).
4. **A probe answering `unknown` leaves the invocation `uncertain`.** Ignorance is never
   converted into a verdict.
5. Uncertainty survives any number of restarts; it is durable state, not an in-memory
   flag.

## Alternatives considered

**A. Retry with idempotency keys and call it exactly-once.** Rejected as dishonest for
non-idempotent effects: the key only deduplicates attempts the kernel *observed*. A
crash before the outcome record is precisely the case the key cannot cover, and claiming
otherwise would make every other guarantee suspect.

**B. Require all external capabilities to be idempotent.** Rejected as unimplementable
against the real world: payment APIs, emails, deployments and physical actuation are not
idempotent, and a runtime that excludes them excludes the interesting work.

**C. Compensate automatically on every uncertain outcome.** Rejected: compensation is
itself an external effect that can fail, and compensating an effect that never landed is
a new bug. Compensation is offered as a disposition, not a default.

**D. Escalate to a human immediately.** Rejected as the *only* option (it is one
disposition among four), because probing resolves most cases automatically and humans do
not scale to routine uncertainty.

## Consequences

**Positive.**
- The runtime can host non-idempotent external effects honestly, which is what
  distinguishes a production AI runtime from a demo.
- The state is auditable: intent, uncertainty, disposition and resolution are all
  journaled with attribution.
- The design makes the *hard* case visible rather than converting it into a silent
  correctness bug.

**Negative (real, and accepted).**
- **It moves a problem to an operator.** An `uncertain` invocation with a non-probeable
  capability needs a human decision. The design makes this visible and attributable; it
  does not make it go away, and at scale it needs tooling that does not exist yet.
- **Correctness depends on truthful trait declarations.** A capability that declares
  itself idempotent when it is not defeats the triage. The kernel cannot verify this;
  mitigation is probes and telemetry, not structure. This is the single largest residual
  risk in doc 20 §5.
- **Compensation can fail**, leaving durable uncertainty with no automatic path forward.
- **An extra durable write per external invocation** (the intent record) is the price of
  detectability.

## Evidence and confidence

- EXECUTABLE (HIGH): `tests/crash.test.ts` — a capability that lands a charge then dies
  produces exactly one world effect, one `uncertain` invocation, and no automatic retry;
  an `unknown` probe answer leaves the state unchanged; compensation reverses the world
  and journals it; idempotent external effects need no uncertainty at all. 375
  uncertainty cycles exercised in the coverage run.
- FACT (HIGH): the absence of any equivalent state in Temporal, Restate, DBOS and A2A is
  documented in `research/notes/durable-execution.md` and `research/notes/a2a-protocol.md`.
- Confidence **HIGH** on the mechanism; **MEDIUM** on operational viability at scale,
  pending the tooling gap above.
