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
| **storage editing the reader's instructions** | the MAC covers `requiredFeatures` and `mustUnderstand` too (A-2). Disarming the fail-closed layer requires a key |
| a middlebox silently dropping an envelope field | the unkeyed checksum covers the same envelope (A-5), and an absent field is malformed rather than lenient (A-6) |
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

**A-2** The MAC preimage MUST bind the **whole record envelope minus its seals**:
`{commitToken, executionId, familyId, writerId, epoch, formatVersion, requiredFeatures,
mustUnderstand, events}`. That binding is what makes a **genuine** record stolen from another
execution, another fork, or an earlier epoch fail — replay of a valid record was the attack
S1's checksum could not see, because it covered only the record's own contents — and it is
what puts the reader's **interpretation instructions** beyond the reach of anyone without a
key.

> **Amended by S1b-1.** A-2 previously bound `{commitToken, executionId, familyId, writerId,
> epoch, formatVersion, events}`, leaving `requiredFeatures` and `mustUnderstand` outside the
> MAC — and outside the checksum, which covered less again. Those two fields are not
> decoration. `mustUnderstand` is the whole of PART 6: it is the writer telling a future
> reader *"if you do not understand this kind, stop."* Storage holding **no key at all** could
> set `mustUnderstand: []`, recompute the unkeyed checksum, leave the MAC untouched, and
> every check still passed. The old reader then met a renamed `effect.landed`, was told by
> someone who was not the writer that it was ignorable, skipped the landing, and the card was
> charged a second time with every invariant green — **F-38 reopened through the MAC gap**
> (docs/30, S1b-1).
>
> The replacement rule does not need re-litigating per field: **the seals cover the whole
> envelope minus the seals themselves.** A field is authenticated by being in the envelope,
> not by someone remembering to add it to two hand-written recipes — which is how three
> fields went missing from one of them.
>
> `keyId` is deliberately outside. It selects a key rather than asserting anything, and a
> swapped `keyId` can only make verification fail. Binding a key to a *writer* is a separate
> and still-open blocker (doc 31, Blocker 3); it needs a policy, not a preimage field.
>
> Changing what the seals cover changed the recipe, so the **format identifier moved with
> it**: `2026-08-18` → `2026-08-19`. See doc 29 §3.2.

**A-3** Verification MUST be constant-time. A verifier that leaks position through timing is
one an attacker can grind against.

**A-4** No signing authority may reach a capability or a consumer. A capability that could
sign could forge history.

**A-5** The checksum and the MAC MUST cover the same envelope under **distinct domains**.
Each preimage carries a domain tag — `kyxo/s1b/commit-record/checksum/1` and
`kyxo/s1b/commit-record/mac/1` — **inside** the canonical structure, not concatenated in
front of it: a prefix on a string is a boundary an attacker can move, a key in a sorted
object is not.

Two reasons, and they are separate:

- **Separation.** Without a tag, a value computed as a checksum preimage is also a valid MAC
  preimage, so any future mechanism that signs a canonical envelope with the journal key —
  the per-family tip Blocker 2 needs, a checkpoint seal, a revocation record — would mint
  signatures interchangeable with commit-record MACs. One field closes the class permanently.
- **Coverage.** The checksum is unkeyed and therefore not a security boundary; anyone with
  disk access recomputes it. What it stops is every change that was not deliberate — a torn
  write, a truncating serializer, a proxy that drops fields it does not recognise.
  `mustUnderstand` is exactly the kind of field such a middlebox drops, and dropping it
  silently disarms the reader, so it belongs under this seal too and not only under the MAC,
  which a keyless journal does not have at all.

**A-6** A record missing an envelope field MUST be refused as **malformed**, not read
leniently, and a verifier MUST NOT supply a default on the writer's behalf. Canonicalisation
omits undefined-valued keys, so a preimage rebuilt from a record with `mustUnderstand`
*deleted* is byte-identical to one from a writer that never wrote the field: stripping would
bypass the seal rather than break it. Every field an S1b writer emits is mandatory on read.
A defaulted field (`?? 'unfenced'`, `?? []`) is a field the reader supplies for the attacker.

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

Evidence: `tests/s1b-authority.test.ts` W1–W4, A1–A6, E1–E6 (A-2, A-5, A-6 — the seals cover
the interpretation instructions, under separated domains), V1–V4 (the identifier moved with
the recipe); `tests/s1-integrity.test.ts` I5.
