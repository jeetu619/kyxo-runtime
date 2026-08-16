# ADR-017 — Capabilities are pure proposers; the commit barrier is structural

Status: **Accepted** (2026-08-16, phase 2). Supersedes the enforcement mechanism assumed
by ADR-012 (verification commit gate); ADR-012's *decision* stands, its *enforcement* is
replaced by this one. Related: ADR-005 (harness as behaviour contract), ADR-013 (ocap).

## Context

The first adversarial review recorded a FATAL finding against the phase-1 prototype: the
commit gate was voluntary. The prototype's own report said it plainly — *"verify() is
runner convention, not a kernel commit gate… nothing kernel-side gates outcome
promotion"* — and the skeptical-CTO reviewer used exactly that to argue Kyxo's
enforcement was no better than middleware, which was one leg of the BUILD-over-EXTEND
argument.

The cause was structural, not accidental. The phase-1 provider contract passed every
capability a live `KernelApi` (`ctx.kernel`) carrying `bind`, `invoke` and
`storeArtifact`. Any capability could therefore produce durable artifacts without an
outcome commit, and any strategy could return a result without ever running a verifier.
A gate implemented above that contract is advisory by construction.

Two candidate fixes were considered: policy stages that require evidence (a *check* on a
surface that remains reachable), or removing the surface.

## Decision

**A capability provider receives data only and affects durable truth exclusively by
proposing effects that the kernel validates and commits.**

1. `InvokeCtx` contains ids, a logical clock value, the request, an optional resume
   payload and a cancellation predicate. No kernel, journal, storage or grant object.
2. Providers `yield` `EffectProposal` values into a staging area they cannot address.
   Staging is volatile and is released on every exit path.
3. The kernel validates at settlement — authority re-check, commit-phase policy, the
   evidence gate — and then writes one atomic commit record, or none.
4. **Delegation requires no kernel handle.** A capability yields a `delegate` proposal
   and receives the child's outcome through the generator's `next()` channel; the kernel
   performs the child invocation under an attenuated grant.
5. Orchestration strategies ("drivers") remain kernel *clients*: they may call verbs but
   cannot append events or mint authority. Two userland roles, two different mechanisms,
   the same prohibition.

## Alternatives considered

**A. Keep the kernel handle, add a mandatory evidence policy stage.** Rejected: it makes
the barrier a property of policy configuration and of the mediator's correctness. Every
future verb added to the facade becomes a new bypass to audit, and a deployment that
misconfigures its stages silently loses the guarantee. This is the incumbent middleware
posture the project claims to improve on.

**B. Effect-typed return values (no streaming proposals).** A provider returns a list of
effects instead of yielding them. Rejected: it forfeits incremental observation
(streaming output is a real requirement), and it cannot express delegation, since a
delegating capability must receive a result mid-execution.

**C. Sandbox providers in separate processes and keep a mediated RPC handle.** Rejected
for V1 as premature: it pays the crossing cost the L4/Mach lesson warns about before the
single-node semantics are proven, and the generator channel already removes the bypass
class. Isolation remains on the roadmap for defence in depth, not for the barrier.

## Consequences

**Positive.**
- The barrier holds against a deliberately hostile capability: the malicious test
  capability enumerates its context, finds no kernel surface, claims success while
  proposing failing evidence, and lands `failed` with **zero** artifacts promoted.
- Recovery correctness follows for free: staged candidates are never durable, so
  "crash cannot promote an unvalidated effect" is true by construction (I16) rather than
  by discipline.
- Delegation became *safer* than the handle design it replaced: because the kernel
  performs every child invocation, recursion is bounded by grant attenuation rather than
  by a counter a capability could ignore.

**Negative (real, and accepted).**
- **Ergonomics.** Writing a capability now means writing an async generator over a
  tagged union. That is less familiar than calling `ctx.kernel.storeArtifact(...)`, and
  the SDK will need helpers to keep the simple case simple. This is a genuine adoption
  cost, flagged for the DX workstream.
- **Providers cannot read committed state directly.** Anything a capability needs must
  arrive in its request, which pushes work onto drivers and makes context assembly an
  explicit step. We judge this a benefit for auditability and a cost for convenience.
- **Generator lifetime is unbounded in this prototype.** A provider that yields forever,
  or never returns, is not yet constrained; proposal-count and runtime bounds are
  required before production (recorded as a residual risk in doc 20 §5).
- **In-process only.** The contract prevents *reaching* the kernel; it does not prevent a
  provider from corrupting shared process state. Containment still requires isolation.

## Evidence and confidence

- SOURCE-CODE OBSERVATION (HIGH): the phase-1 prototype's own findings recorded the
  voluntary gate and the missing kernel-side enforcement.
- EXECUTABLE (HIGH): `prototypes/kernel-semantics/tests/universality.test.ts` —
  malicious-capability containment and evidence-gate override; `invariants.ts` I3, I4,
  I16, I17 asserted after every operation across 9,300 checks.
- Confidence **HIGH** that the barrier is structural under single-process assumptions;
  **MEDIUM** that the ergonomics are acceptable without SDK sugar — that is an adoption
  question executable evidence cannot settle.
