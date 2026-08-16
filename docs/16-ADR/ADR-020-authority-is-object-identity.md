# ADR-020 — Authority is object identity; grant limits are ceilings, not reservations

Status: **Accepted** (2026-08-16, phase 2). Amends ADR-013 (object-capability security)
and ADR-014 (budgets as attenuated quantitative grants). Implements amendment A8.

## Context

Two things were established by execution rather than argument.

**First**, the review's security reviewer observed that the phase-1 kernel resolved any
grant-id string presented by any in-process caller against a global table — "knowing a
string IS holding authority", the exact critique the ADRs used to disqualify incumbents.
Amendment A8 required handle-shaped authority. The first attempt at implementing it
*failed the same way*: `GrantHandle` was guarded by a symbol which the types module
exported, so any module could import the guard and mint a valid handle for any id read
off a journal event (doc 20 F-2).

**Second**, an attack script during review #2 showed that sibling grants can overcommit:
a parent holding 5 invocations minted ten children each declaring 4. Investigation showed
spend was correctly bounded (40 attempts, 5 admitted) — but the documentation implied a
guarantee the system does not give (doc 20 F-7).

## Decision

1. **Authority is object identity.** The kernel mints `GrantHandle` objects and records
   them in a private `WeakSet`. An operation is authorized iff the presented object is in
   that set. Ids appearing in journal events are non-resolvable identifiers: useful for
   audit, useless as credentials.
2. **Grant limits are ceilings enforced along the whole chain at admission**, not
   partitioned reservations. Sibling limits may sum beyond the parent; actual spend is
   bounded by every ancestor. This is thin provisioning, and it is now specified
   (doc 17 §9a) rather than implied.
3. Reservation and settlement (amendment A2) apply to invocations in flight: admission
   reserves durably before dispatch; the outcome settles or releases.
4. Attenuation validates against the parent's **current** state, and every refusal is
   journaled.

## Alternatives considered

**A. Signed capability tokens (macaroon-style).** Rejected for the in-process V1: it
substitutes cryptographic verification for identity, adds key management, and buys
nothing while the trust boundary is a process boundary. It becomes the right answer the
moment authority must cross a wire — recorded as the intended evolution, not a rejection
on merit.

**B. Opaque integer handles in a private table.** Rejected: functionally similar, but any
integer that leaks into a log becomes forgeable, which is the failure mode we are
eliminating. Object identity cannot be transcribed.

**C. Hard-partitioned budgets (attenuation deducts from the parent).** Seriously
considered and rejected as the default: AI workloads cannot predict how spend distributes
across delegated branches, and partitioning strands budget in branches that never run. An
implementation MAY offer it as a mode; the guarantee specified is the chain bound.

## Consequences

**Positive.**
- Three concrete forgery attacks — constructing the class with a known id, prototype
  forgery, and shallow-copying a genuine handle — are all rejected, while the genuine
  object still works.
- Authority cannot leak through logs, traces, error messages or journal exports, which is
  where credentials usually escape.
- Thin provisioning matches how delegated AI work actually consumes budget.

**Negative (real, and accepted).**
- **Handles do not survive a process restart.** A recovered kernel has minted no handles,
  so authority must be re-obtained after recovery. For long-running executions this
  re-acquisition path is currently unspecified, and specifying it badly would reintroduce
  a "re-issue anything" hole. **This is an open design question**, recorded in doc 20 §5
  and expected to be pressed by review #2.
- **Handles cannot cross a process or network boundary**, which means an SDK client
  cannot hold one directly. Remote authority needs the token design of alternative A —
  so this decision is explicitly V1-scoped, not a permanent answer.
- **A grant's limit can mislead.** "You may spend 4" does not mean 4 are set aside; a
  sibling may consume the parent first. Denials are journaled, but the developer-facing
  surface must not present ceilings as allocations.

## Evidence and confidence

- EXECUTABLE (HIGH): `tests/grants.test.ts` — three forgery attacks rejected; attenuation
  refuses added rights and excess budget; transitive revocation; expiry at time of use;
  fork does not resurrect revoked authority; delegation attenuation; two recursion
  bounds; sibling overcommit with spend bounded at exactly the parent budget.
- Runtime invariants I5, I18, I21, I23 asserted after every operation.
- Confidence **HIGH** for in-process authority; **LOW** that this design extends to
  distributed authority unchanged — it does not, and alternative A is the intended path.
