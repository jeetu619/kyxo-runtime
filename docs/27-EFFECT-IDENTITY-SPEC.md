# 27 — Effect Identity (normative)

Status: **NORMATIVE DRAFT**, 2026-08-16, Wave S1b. Identity scheme `kyxo.effect-identity/1`.
Executable form: `prototypes/kernel-semantics/src/s1b-identity.ts`. Evidence: `docs/30`.

RFC 2119 terms are used for genuine conformance requirements.

---

## 1. Why this document exists

Wave S1 derived the effect key as `sha({capabilityId, step, request})` — the whole request.
Six independent reviewers converged on the same verdict, and it is the reason S1 could not
be frozen: **that is not an identity, it is a checksum.** It answers "are these the same
bytes?" when the question that decides whether to charge a card is "are these the same
operation?"

Those two questions coincide only when a request contains nothing incidental, which is
never. Every one of these ordinary developer behaviours produced a second real charge under
S1, with a green test suite:

| Behaviour | Why it broke |
|---|---|
| fresh idempotency nonce per attempt | the habit Stripe's own docs teach |
| `requestedAt` / `createdAt` | a timestamp is not part of what the operation *is* |
| regenerated UUID / trace id / correlation id | observability metadata changed the key |
| retried job, re-run workflow | new attempt, new bytes, new key |
| array field whose order varies | a set serialised from a `Map`, or DB row order |
| forgotten `step` | it silently defaulted to the string `'anon'` |

The runtime was asking the wrong question, and the cost of the wrong answer was money.

---

## 2. Three identities, deliberately distinct

The single most important thing this specification does is refuse to conflate three things
S1 treated as one.

| Identity | What it names | Stable across a retry? | May decide an irreversible dispatch? |
|---|---|---|---|
| **Invocation identity** | this attempt (`inv_000123`) | **no**, by design | never |
| **Request identity** | these exact bytes (`sha(canonical(request))`) | no | **never** |
| **Semantic effect identity** | the real-world operation | **yes**, by construction | **yes** — this is its only job |

An invocation identity names a row in the journal. A request identity is useful for
debugging and delivery dedup. Only semantic effect identity may gate an irreversible
effect, and it is the only one this document specifies.

---

## 3. Where identity comes from

The kernel MUST NOT infer which request fields are semantic. That is domain knowledge, and
a runtime that guesses at it will guess wrong in exactly the cases that cost money.

Identity MUST come from one of two explicit sources, in this precedence order:

### 3.1 Caller-supplied business identity (highest precedence)

```ts
k.invoke(exec, 'payments.stripe', request, grant, { idempotencyKey: 'INV-42' })
```

The caller names the operation: an invoice number, an order id, a job id — something stable
across retries **by construction** rather than by luck. This beats a capability schema
because the caller knows the business identity while the capability knows only the shape of
its own arguments.

Derivation: `sha({scheme, namespace, operation, idempotencyKey})`.

### 3.2 Capability-declared semantic projection

```ts
manifest.identity = { operation: 'payments.charge', fields: ['invoiceId', 'amount', 'currency'] }
```

`fields` is an **allowlist**, and that is load-bearing. A nonce is excluded because it was
never named — not because someone remembered to exclude it. A blocklist would have to
predict every incidental field any caller might ever add, and blocklists are always
incomplete. This is also why adding telemetry to an existing request cannot change identity.

Derivation: `sha({scheme, namespace, operation, semantics})` where `semantics` is the
projection of the allowlisted paths, key-sorted.

### 3.3 No identity — the fail-closed rule

If neither source exists and the effect class is `external-irreversible` or
`external-compensatable`, the kernel **MUST refuse the invocation**.

It MUST NOT fall back to hashing the request. That fallback is the S1 defect: it is silent,
it looks like it works, and it fails only in production and only with money. Convenience
does not get to become a double-charge risk by default.

Classes that are repeatable by declaration (`pure`, `local`, `external-idempotent`) are not
burdened: fail-closed applies where repetition is dangerous, not everywhere.

---

## 4. Normative rules

**I-1** Identity MUST be resolved before admission and MUST be an input to the admission
claim (doc 17 B1). An identity computed after dispatch protects nothing.

**I-2** Identity MUST be **persisted** in `invocation.admitted`, together with its scheme,
source, operation and namespace. A reader MUST NOT re-derive an identity it can read. This
is what makes a format upgrade safe: a changed derivation would otherwise silently
re-identify every effect in history and make every one of them repeatable.

**I-3** The identity scheme MUST be versioned **independently of the record format**. A
format revision must be able to change record layout without changing what counts as the
same effect.

**I-4** A reader meeting an identity scheme it does not implement MUST fail closed.

**I-5** An absent semantic field MUST be represented by a stable sentinel, not by omission
and not by an error. Omission would make `{a:1}` and `{a:1,b:2}` collide; an error would
make optional semantic fields impossible, and "charge with no currency" is a legitimate
operation that differs from "charge with one".

**I-6** If **every** declared field is absent, the kernel MUST refuse: the schema does not
describe this request, so any key derived from it would be shared by every such request —
a collision presented as an identity.

**I-7** A value that cannot be canonicalised (a `Date`, `Map`, `Set`, class instance,
non-finite number) in an identity field MUST be refused. Under S1 these hashed to `{}`, so
two different charges collided.

**I-8** `step` participates in identity **only** on the fallback path. Where a schema or an
`idempotencyKey` exists, whoever declared identity owns it, and letting an incidental step
split a declared identity would reintroduce the S1 defect.

**I-9** Identity is anchored on the **operation name, not the capability id**. Two
capabilities declaring the same operation ARE the same operation. This is what allows a
wrapper, a retry shim or a v2 rollout to preserve identity instead of re-charging
everything.

---

## 5. Scope: what identity does and does not span

Identity is scoped to a **family** — a lineage tree — matching the protected-effect ledger
(ADR-025). Within a family, one semantic effect executes at most once.

**Across families it does not apply, and this is a stated limitation, not an oversight.**
Two `createExecution()` calls create two families. A cron job that re-runs, or a broker that
redelivers a workflow-start message, therefore gets a second charge unless the caller
carries the same execution — or supplies an `idempotencyKey`, which is exactly what it is
for. The mitigation exists; discoverability of it is assessed in doc 30.

---

## 6. The escape hatch

`unsafeRequestHashIdentity: { reason }` restores S1's behaviour for one invocation. It:

- **requires the `unsafe-effect-identity` right** on the grant — asking is not the same as
  being permitted, and permission is granted by whoever issued the grant, not by the caller;
- is **journaled** with its reason, and the resulting identity records
  `source: 'unsafe-request-hash'` so an auditor can see which model produced the key;
- **does not propagate** to delegated invocations. An unsafe choice is made about one call
  by someone who accepted the risk; inheriting it downward would let one legacy call
  quietly disable protection for a whole subtree.

It is never an innocuous boolean buried in a request.

---

## 7. Conformance evidence

`prototypes/kernel-semantics/tests/s1b-identity.test.ts`, 24 tests, every one counting
**actual external executions** rather than returned statuses. ID1–ID10 are the ordinary
developer behaviours above; ID11–ID14 are the opposite direction (different effects must not
collide, because over-dedup is the mirror-image failure and equally wrong); ID15–ID17 are
the fail-closed rule; ID18–ID19 the escape hatch; ID20–ID24 cross-version stability and
canonicalisation refusal.
