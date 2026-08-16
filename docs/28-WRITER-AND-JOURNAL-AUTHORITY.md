# 28 — Writer Identity and Journal Authority (normative)

Status: **NORMATIVE DRAFT**, 2026-08-16, Wave S1b.
Executable form: `prototypes/kernel-semantics/src/s1b-writer.ts`. Evidence: `docs/30`.

---

## 1. Two problems that must compose, and are constantly conflated

| | Question | Mechanism |
|---|---|---|
| **Authenticity** | were these bytes written by someone holding a key? | per-record MAC |
| **Authority** | is that someone the writer who currently owns this family? | epoch fencing |

A cryptographically perfect signature from a writer that lost its lease is still a write
that must be refused. **Authentication is not authorization; a signing key is not a lease.**
S1's format had neither, and the reviewers demonstrated both consequences.

---

## 2. Why this could not wait for a later revision

Two S1 kernels recovered from one journal produced **byte-identical commit records** — same
commit token, same event ids, same `seq`, same `occurredAt`, because every one of those is a
per-process counter that recovery restores identically. Two writers double-charged a card
and the evidence was indistinguishable from an at-least-once redelivery, so a reader that
deduplicated by commit token (the natural design for an append-only log) was *correct* to
collapse them and *wrong* about the money.

"We do not claim multi-writer safety" is a defensible scope limit. Shipping a format in
which the violation is **unattributable** is not — and `writerId` and `epoch` cannot be
added to records already written. That is what makes it a freeze blocker rather than a
backlog item.

---

## 3. Threat model, stated before the guarantees

**In scope — detected or prevented**

| Threat | Mechanism |
|---|---|
| accidental corruption, torn writes | hash chain + sequence density |
| record deletion, reordering, replay | chain + seq + family/writer/epoch binding in the MAC preimage |
| stale writer after takeover | epoch fencing, checked per append |
| **malicious storage** | per-record MAC — storage holds no writer key |
| capability / consumer code | no key or signer reaches userland |

**Out of scope, stated plainly**

- A **compromised writer process** holding a live key can write anything within its own
  epoch. No in-process mechanism fixes that. `Signer` is an interface precisely so an
  external signer or HSM can be substituted later; this design does not claim to be one.
- **Key loss** makes historical records unverifiable but not unreadable. Verification is
  separable from folding, so an operator can recover with an explicit, journaled downgrade.
  Silent downgrade is not offered: "we could not check" and "we checked and it was fine"
  must never look the same.

---

## 4. Writer identity, epochs, fencing

**W-1** Every authoritative record MUST carry `writerId` and `epoch`.

**W-2** Ownership MUST be acquired through a **compare-and-set**: acquisition succeeds only
if the caller's view of the current epoch is correct. Taking over bumps the epoch.

**W-3** Ownership MUST be checked **per append**, not once at acquisition. A writer that was
legitimate when it started can be superseded mid-flight, and checking only at acquisition
leaves most of the writer's life unfenced.

**W-4** Fencing MUST be configured **before a family's first append**. Configuring it
afterwards leaves an unsigned prefix in a signed journal, and an unsigned prefix is
indistinguishable from one whose MAC an attacker stripped (docs/20 F-39).

**W-5** The kernel MUST refuse to act on a journal it does not own. It **cannot prevent**
another process appending — no in-process mechanism can — so:

> **Prevention requires a storage primitive.** `WriterRegistry` states that requirement
> rather than assuming it. A production backend must supply an equivalent: a DynamoDB
> conditional write, a Postgres row lock, an etcd lease, a blob lease. A backend that cannot
> does not get single-writer, and the runtime must say so at configuration time rather than
> discover it during an incident.

---

## 5. Journal authenticity

**A-1** Every record MUST carry a `mac` and the `keyId` that produced it.

**A-2** The MAC preimage MUST bind `{commitToken, executionId, familyId, writerId, epoch,
formatVersion, events}`. That binding is what makes a **genuine** record stolen from another
execution, another fork, or an earlier epoch fail — replay of a valid record was the attack
S1's checksum could not see, because it covered only the record's own contents.

**A-3** Verification MUST be constant-time. A verifier that leaks position through timing is
one an attacker can grind against.

**A-4** No signing authority may reach a capability or a consumer. A capability that could
sign could forge history.

---

## 6. Key lifecycle

Answered explicitly, because "we'll sort keys out later" is how a format ends up unable to
rotate.

| Question | Answer |
|---|---|
| who owns keys | the runtime operator; never a capability, never a consumer |
| creation | one key per writer identity, minted out of band |
| **rotation** | add a key under a **new** `keyId` and sign with it. Old records keep verifying because each record names the key that signed it. **Rotation is not a migration.** |
| loss | records become unverifiable, not unreadable. Recovery requires explicit `{ acceptUnverifiable: true }`. |
| compromise | remove the key from the keyring; records it signed stop verifying. Revocation is an operator act, not an inference. |
| consumers | never receive signing authority |

---

## 7. Interaction: fencing and authenticity together (PART 9)

The composition test is the one that matters:

> Writer epoch 7 signs a record. Writer epoch 8 takes over. The epoch-7 writer wakes and
> attempts a **cryptographically valid** write.

It MUST be rejected. `assertOwns` refuses it on the write path, and the epoch inside the MAC
preimage means the record would not verify on the read path either. Authenticity says the
bytes are genuine; only the fence says the writer may still speak.

Evidence: `tests/s1b-authority.test.ts` W1–W4, A1–A6.
