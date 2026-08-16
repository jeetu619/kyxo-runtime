# ADR-027 — The integrity chain covers the payload hash, not the payload

Status: **Accepted** (2026-08-16, Wave S1). Resolves blocker B8 in part and blocker B6 in
full. Amends ADR-002's journal format.

---

## 1. Context

Doc 17 §2 specified redaction-by-tombstone. The format could not perform it: the hash chain
covered the payload directly, so removing a payload broke the chain, and there was no way
to distinguish a lawful erasure from tampering. The specification described a capability
that did not exist — the class of defect doc 22 criterion 11 exists to catch.

Separately (B6), `readJournal()` skipped any record whose checksum failed and *continued*,
so corruption in the middle of the journal silently truncated history while everything
downstream still verified.

## 2. Decision

**Every event carries `payloadHash`, and the chain's preimage contains the hash rather than
the payload.**

This makes three cases distinguishable, which is the whole point:

| Operation | Chain verifies | Payload matches hash |
|---|---|---|
| lawful redaction (payload replaced by a tombstone) | yes | marked redacted |
| payload silently rewritten | yes | **no** — detected |
| payload and hash rewritten together | **no** — hash is in the preimage | n/a |

**The commit checksum covers the whole record**, not just the events array, so a record
cannot be re-attributed to another execution or family without detection.

**Recovery fails closed on non-trailing corruption.** A trailing bad record is an
interrupted write and discarding it is correct. A bad record with valid records after it is
corruption, and folding past it deletes history from the middle of the log while everything
downstream still looks consistent. Recovering quietly from that is worse than not
recovering, because nobody finds out. Quarantine is available as an explicit operator
override — a decision, never a default.

**Which bytes a checksum covers is a record-format decision, not a storage decision.**
Storage keeps bytes and is handed a verifier. This was forced by F-11, where a hard-coded
recipe in the storage layer made every record of the new format verify as torn, and
recovery silently saw an empty journal.

## 3. Known limit: redaction is a multi-event operation

The same datum appears in more than one payload — `invocation.admitted` carries the request
so a suspended invocation can be re-entered from a cold start, and `state.updated` carries
what was derived from it. Erasure must therefore find every event carrying the datum.

`s1-integrity` I2 asserts the exact duplication count, so a revision that adds another copy
fails a test rather than quietly enlarging the erasure surface. The structural answer —
carrying sensitive payloads by artifact reference so erasure has one target — is not
implemented and is named as owed work in doc 25 §8.

## 4. What B8 still leaves open

`leaseEpoch` is declared in the record format and implemented nowhere. Taint is claimed as a
kernel invariant in doc 11 and does not exist in the kernel. Both must be implemented or
normatively withdrawn before freeze. This ADR does neither; it resolves the redaction half
of B8 and says plainly that the other half is untouched.

## 5. Alternatives considered

**Redaction by rewriting the chain.** Rejected: it makes every historical hash unverifiable
and turns erasure into an operation only the writer can perform.

**Encrypt payloads and delete keys (crypto-shredding).** Not rejected on merit — it is a
reasonable alternative and composes with this decision rather than competing with it. Out of
scope: it needs key management, which is a subsystem, not a field.

## 6. Consequences

**Positive.** Redaction is real and demonstrated. Tampering and redaction are
distinguishable. Mid-journal corruption is loud. The two record formats sharing one store
cannot be confused for each other.

**Negative.** An attacker who can write the journal can still replace a payload with a
tombstone and claim it was a lawful erasure; the chain cannot distinguish a lawful redactor
from a hostile one, only a hash-preserving edit from a hash-breaking one. Distinguishing
*who* redacted requires signed redaction records, which this ADR does not add.

## 7. Evidence

`s1-integrity.test.ts` — 12 tests including the three-way distinction above, whole-record
checksum re-attribution attempts, fail-closed vs trailing-torn recovery, a golden-corpus
conformance anchor, and version-relabelling detection. `s1-security` A9 attacks with a
*genuine* replayed record rather than a forged one, and it is caught by sequence density
rather than by the checksum.

Confidence: **HIGH**.
