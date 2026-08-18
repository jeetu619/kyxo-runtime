/**
 * Writer identity, epochs, fencing, and journal authenticity.
 *
 * TWO SEPARATE PROBLEMS THAT MUST COMPOSE, AND ARE CONSTANTLY CONFLATED.
 *
 *   Authenticity  "these bytes were written by someone holding a key."
 *   Authority     "that someone is the writer who currently owns this family."
 *
 * A cryptographically perfect signature from a writer that lost its lease is still a
 * write that must be refused. Authentication is not authorization; a signing key is not
 * a lease. S1's format had neither, and the reviewers demonstrated both consequences.
 *
 * WHAT S1 SHIPPED, AND WHY IT COULD NOT BE PATCHED LATER.
 *
 * Two S1 kernels recovered from one journal produced BYTE-IDENTICAL commit records: the
 * same commit token, the same event ids, the same `seq`, the same `occurredAt` — because
 * every one of those is a per-process counter that recovery restores identically. Two
 * writers double-charged a card and the evidence was indistinguishable from an
 * at-least-once redelivery, so a reader that deduplicated by commit token (the natural
 * design for an append-only log) was *correct* to collapse them and *wrong* about the
 * money.
 *
 * "We do not claim multi-writer safety" is a defensible scope limit. Shipping a format in
 * which the violation is UNATTRIBUTABLE is not, and it is precisely the kind of thing a
 * freeze makes permanent: `writerId` and `epoch` cannot be added to records already
 * written.
 *
 * THREAT MODEL — stated first, so the guarantees can be bounded honestly.
 *
 *   IN SCOPE
 *     accidental corruption ........... detected (hash chain, per-record MAC)
 *     torn / partial writes ........... detected (chain + sequence density)
 *     record deletion, reorder, replay  detected (chain + sequence + family/epoch binding)
 *     stale writer after takeover ..... refused (epoch fencing, storage CAS)
 *     malicious STORAGE .............. detected — storage does not hold a writer key
 *     capability / consumer code ...... cannot forge — no key reaches userland
 *
 *   OUT OF SCOPE, STATED PLAINLY
 *     a compromised WRITER PROCESS holding a live key can write anything it likes within
 *     its own epoch. No in-process mechanism fixes that; it needs an external signer or
 *     an HSM, and this design leaves room for one (`Signer` is an interface) without
 *     claiming to be one.
 *
 *     key loss makes historical records unverifiable but NOT unreadable — verification is
 *     separable from folding, so an operator can still recover with an explicit,
 *     journaled downgrade. Silent downgrade is not offered.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, sha } from './storage.ts';

export class WriterFencedError extends Error {}
export class AuthenticityError extends Error {}

/** Identifies a process that may append. Distinct from an execution and from a grant. */
export type WriterId = string & { readonly __brand: 'WriterId' };

/**
 * A lease over one family. `epoch` is the fencing token: monotonic, and every authoritative
 * record carries the epoch it was written under.
 */
export interface WriterLease {
  readonly familyId: string;
  readonly writerId: WriterId;
  readonly epoch: number;
  readonly keyId: string;
}

/**
 * Signing is an interface, not a function, so the key can live somewhere else later
 * (a KMS, an HSM, a sidecar) without a format change. What the format commits to is that
 * a record carries a `keyId` and a `mac`, not how the mac was produced.
 */
export interface Signer {
  readonly keyId: string;
  sign(preimage: string): string;
  verify(preimage: string, mac: string, keyId: string): boolean;
}

/**
 * Development signer: HMAC-SHA256 with an in-memory keyring.
 *
 * KEY LIFECYCLE, answered explicitly because "we'll sort keys out later" is how a format
 * ends up unable to rotate:
 *
 *   who owns keys      the runtime operator, never a capability and never a consumer.
 *                      Nothing in `InvokeCtx` or any manifest can reach a key.
 *   creation           one key per writer identity, minted out of band.
 *   rotation           add the new key under a NEW keyId and start signing with it.
 *                      Old records keep verifying because each record names the key that
 *                      signed it, and the keyring retains retired keys for verification
 *                      only. Rotation is therefore not a migration.
 *   loss               historical records become unverifiable, not unreadable. Recovery
 *                      requires an explicit `{ acceptUnverifiable: true }`, which is
 *                      journaled. There is no silent downgrade.
 *   compromise         remove the key from the signing set; records it signed are marked
 *                      suspect from the revocation point. Revocation is an operator record,
 *                      not an inference.
 */
export class KeyringSigner implements Signer {
  private readonly keys = new Map<string, Buffer>();
  private active: string;

  constructor(keyId: string, secret: string) {
    this.keys.set(keyId, Buffer.from(secret, 'utf8'));
    this.active = keyId;
  }

  get keyId(): string { return this.active; }

  /** Add a key and start signing with it. Old keys stay for verification (rotation). */
  rotate(keyId: string, secret: string): void {
    this.keys.set(keyId, Buffer.from(secret, 'utf8'));
    this.active = keyId;
  }

  /** Remove a key entirely: records it signed stop verifying (compromise). */
  revoke(keyId: string): void {
    if (keyId === this.active) throw new AuthenticityError('cannot revoke the active signing key');
    this.keys.delete(keyId);
  }

  sign(preimage: string): string {
    const key = this.keys.get(this.active)!;
    return createHmac('sha256', key).update(preimage).digest('hex');
  }

  verify(preimage: string, mac: string, keyId: string): boolean {
    const key = this.keys.get(keyId);
    if (key === undefined) return false;
    const expected = createHmac('sha256', key).update(preimage).digest('hex');
    if (expected.length !== mac.length) return false;
    // Constant-time: a verifier that leaks position through timing is a verifier an
    // attacker can grind against.
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
    } catch {
      return false;
    }
  }
}

/**
 * THE AUTHENTICATED ENVELOPE — every field of a commit record except its seals.
 *
 * S1b-1: `macPreimage` used to cover `{commitToken, executionId, familyId, writerId, epoch,
 * formatVersion, events}`, and the checksum covered less than that again — only
 * `{commitToken, executionId, familyId, events}`. `requiredFeatures` and `mustUnderstand`
 * were outside BOTH.
 *
 * Those two fields are not decoration; they are the reader's INTERPRETATION INSTRUCTIONS.
 * `mustUnderstand` is the whole of PART 6: it is what stops an old reader treating a
 * revision-2027 `world.landed` as an ignorable unknown, losing the landing and charging the
 * card again. Leaving it unauthenticated meant storage holding NO KEY could set it to `[]`,
 * recompute the unkeyed checksum, leave the MAC untouched, and every check still passed —
 * the fail-closed layer voided from outside, F-38 reopened through the MAC gap.
 *
 * So the rule is now the only rule that does not need re-litigating per field: **the seals
 * cover the whole envelope minus the seals themselves.** A new field is authenticated by
 * being added here, not by someone remembering to add it to two recipes.
 *
 * `keyId` is deliberately outside: it selects the key rather than asserting anything, and a
 * swapped `keyId` can only make verification fail. Binding a key to a *writer* is a
 * separate, unclosed blocker (doc 31 Blocker 3) and needs a policy, not a preimage field.
 */
export interface RecordEnvelope {
  readonly commitToken: string;
  readonly executionId: string;
  readonly familyId: string;
  readonly writerId: string;
  readonly epoch: number;
  readonly formatVersion: string;
  /** Features a reader must implement to interpret this record safely. */
  readonly requiredFeatures: readonly string[];
  /** Which of this record's kinds are safety-critical, decided by the writer. */
  readonly mustUnderstand: readonly string[];
  readonly events: unknown;
}

/**
 * DOMAIN SEPARATION. The same bytes signed for two purposes is one purpose too many.
 *
 * The checksum and the MAC cover the same envelope, which is the point — but a preimage
 * that does not say what it is FOR can be carried between purposes. Without a tag, a value
 * computed as a checksum preimage is also a valid MAC preimage, so any future mechanism
 * that signs a canonical envelope with the journal key (a checkpoint seal, the per-family
 * tip Blocker 2 needs, a revocation record) would produce signatures interchangeable with
 * commit-record MACs. Tagging costs one field and closes the class permanently.
 *
 * The tag is inside the canonical structure, not concatenated in front of it: a prefix on a
 * string is a boundary an attacker can move, a key in a sorted object is not.
 */
export const RECORD_CHECKSUM_DOMAIN = 'kyxo/s1b/commit-record/checksum/1';
export const RECORD_MAC_DOMAIN = 'kyxo/s1b/commit-record/mac/1';

/** The bytes a seal covers, for one named purpose. */
export function recordPreimage(domain: string, env: RecordEnvelope): string {
  return canonical({
    domain,
    envelope: {
      commitToken: env.commitToken, executionId: env.executionId, familyId: env.familyId,
      writerId: env.writerId, epoch: env.epoch, formatVersion: env.formatVersion,
      requiredFeatures: [...env.requiredFeatures], mustUnderstand: [...env.mustUnderstand],
      events: env.events,
    },
  });
}

/**
 * The bytes a record's MAC covers.
 *
 * Binds the record to its family, its writer, its epoch, its position AND the instructions
 * a reader will interpret it under. That binding is what makes a *genuine* record stolen
 * from another execution, another fork, or an earlier epoch fail verification — replay of a
 * valid record is the attack the S1 format could not see, because its checksum covered only
 * the record's own contents.
 */
export function macPreimage(env: RecordEnvelope): string {
  return recordPreimage(RECORD_MAC_DOMAIN, env);
}

/**
 * The record's unkeyed integrity seal.
 *
 * It is NOT a security boundary — it is unkeyed, so anyone with disk access can recompute
 * it, and only the MAC stops a knowing attacker. What it does stop is every mutation that
 * is not deliberate: a torn write, a truncating serializer, a proxy that drops fields it
 * does not recognise. `mustUnderstand` is exactly the kind of field such a middlebox drops,
 * and dropping it silently disarms the reader — so it belongs under this seal too, not only
 * under the MAC, which a keyless journal does not have at all.
 */
export function recordChecksum(env: RecordEnvelope): string {
  return sha(recordPreimage(RECORD_CHECKSUM_DOMAIN, env));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * THE ENVELOPE'S FIELD LIST, IN ONE PLACE, WITH THE SHAPE EACH FIELD MUST HAVE.
 *
 * A table rather than a run of hand-written `if`s, for the reason S1b-1 exists: the field
 * list previously lived in several hand-copies (the writer's, the checksum's, the MAC's)
 * and three fields went missing from two of them. `envelopeOf` and `envelopeFault` are the
 * next two copies waiting to happen — one deciding whether a record is well-formed and one
 * saying why — so they read the same table instead of each other's intentions.
 */
const ENVELOPE_SHAPE: readonly (readonly [string, (v: unknown) => boolean, string])[] = [
  ['commitToken', (v) => typeof v === 'string', 'a string'],
  ['executionId', (v) => typeof v === 'string', 'a string'],
  ['familyId', (v) => typeof v === 'string', 'a string'],
  ['writerId', (v) => typeof v === 'string', 'a string'],
  ['epoch', (v) => typeof v === 'number' && Number.isFinite(v), 'a finite number'],
  ['formatVersion', (v) => typeof v === 'string', 'a string'],
  ['requiredFeatures', isStringArray, 'an array of strings'],
  ['mustUnderstand', isStringArray, 'an array of strings'],
  ['events', (v) => Array.isArray(v), 'an array'],
];

/**
 * Why this value is not a well-formed S1b envelope, or `null` if it is.
 *
 * WHY A REASON AND NOT A BOOLEAN, which is the second half of the S1b-1 fix.
 *
 * `envelopeOf` answers "can I read this?" with `null`, and a `null` is indistinguishable
 * from every other reason a verifier might say no — including "the checksum did not match",
 * which the format DELIBERATELY treats as a discardable interrupted write. Collapsing the
 * two let a record with `mustUnderstand` deleted be discarded as though it were torn: the
 * reader's own interpretation instructions could be removed and the record would simply
 * vanish, silently, taking a landing with it (S1b-1 review 7).
 *
 * A torn record and a stripped record are not the same event and must not reach the same
 * outcome, so the fault is stated rather than implied, and the caller that owns the
 * distinction — `verifyS1Record` — refuses instead of discarding.
 */
export function envelopeFault(record: unknown): string | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return 'it is not a JSON object, so it is not a commit record at all';
  }
  const r = record as Record<string, unknown>;
  for (const [field, shaped, shape] of ENVELOPE_SHAPE) {
    if (!(field in r)) {
      return `envelope field '${field}' is missing, and every S1b writer emits it`;
    }
    if (!shaped(r[field])) return `envelope field '${field}' is not ${shape}`;
  }
  return null;
}

/**
 * Read the envelope out of an untrusted record, or refuse.
 *
 * FAIL CLOSED ON ABSENCE, and this is the subtle half of the fix. `canonical` omits
 * undefined-valued keys, so a preimage built from a record with `mustUnderstand` DELETED is
 * byte-identical to one built from a record that never had the field — strip becomes
 * indistinguishable from absence and the seal is bypassed rather than broken. A field that
 * every S1b writer emits is therefore MANDATORY on read: a record missing one is malformed,
 * not lenient input.
 *
 * There is also no defaulting here (no `?? 'unfenced'`, no `?? []`). A reader that fills in
 * a field the writer sealed is a reader that computes a different preimage than the writer
 * did, which is either a spurious failure or — when the default happens to match — a hole.
 *
 * `null` here means only "not readable as an envelope". It does NOT mean "discard this
 * record": see `envelopeFault`, and `verifyS1Record`, which turns that fault into a refusal.
 */
export function envelopeOf(record: unknown): RecordEnvelope | null {
  if (envelopeFault(record) !== null) return null;
  const r = record as Record<string, unknown>;
  return {
    commitToken: r['commitToken'] as string,
    executionId: r['executionId'] as string,
    familyId: r['familyId'] as string,
    writerId: r['writerId'] as string,
    epoch: r['epoch'] as number,
    formatVersion: r['formatVersion'] as string,
    requiredFeatures: r['requiredFeatures'] as string[],
    mustUnderstand: r['mustUnderstand'] as string[],
    events: r['events'],
  };
}

/**
 * Writer ownership, held by storage because only storage can make it atomic.
 *
 * THIS IS THE HONEST PART. The kernel cannot enforce single-writer by itself — it has no
 * way to stop another process appending to a file. What it can do is refuse to *act* on a
 * journal it does not own, and carry an epoch that makes a stale write detectable after
 * the fact. Prevention requires a storage primitive: a compare-and-set on an owner record.
 *
 * `WriterRegistry` is that primitive, stated as a requirement rather than assumed. A
 * production backend must provide an equivalent (a DynamoDB conditional write, a Postgres
 * row lock, an etcd lease, a blob lease). If a backend cannot, then single-writer is not
 * available on it and the runtime must say so at configuration time rather than discover
 * it during an incident.
 */
export interface WriterRegistry {
  /**
   * Atomically take ownership of a family. Succeeds only if the caller's view of the
   * current epoch is correct — that is the compare-and-set.
   */
  acquire(familyId: string, writerId: WriterId, expectedEpoch: number | null): WriterLease;
  current(familyId: string): { writerId: WriterId; epoch: number } | undefined;
}

export class InMemoryWriterRegistry implements WriterRegistry {
  private readonly owners = new Map<string, { writerId: WriterId; epoch: number }>();

  acquire(familyId: string, writerId: WriterId, expectedEpoch: number | null): WriterLease {
    const cur = this.owners.get(familyId);
    const curEpoch = cur?.epoch ?? 0;
    if (expectedEpoch !== null && expectedEpoch !== curEpoch) {
      throw new WriterFencedError(
        `family ${familyId}: expected epoch ${String(expectedEpoch)}, current is ${String(curEpoch)}`,
      );
    }
    const epoch = curEpoch + 1;
    this.owners.set(familyId, { writerId, epoch });
    return { familyId, writerId, epoch, keyId: '' };
  }

  current(familyId: string): { writerId: WriterId; epoch: number } | undefined {
    return this.owners.get(familyId);
  }
}

/**
 * Is this lease still the owner?
 *
 * Called before every authoritative append. A writer that paused, was superseded, and then
 * woke up holds a lease with a stale epoch and is refused here — with a valid key and a
 * valid MAC, which is the entire point of PART 9. Authenticity says the bytes are genuine;
 * only this says the writer may still speak.
 */
export function assertOwns(registry: WriterRegistry, lease: WriterLease): void {
  const cur = registry.current(lease.familyId);
  if (cur === undefined) {
    throw new WriterFencedError(`family ${lease.familyId} has no writer; this lease is void`);
  }
  if (cur.epoch !== lease.epoch || cur.writerId !== lease.writerId) {
    throw new WriterFencedError(
      `writer ${lease.writerId}@${String(lease.epoch)} is stale: ` +
      `family ${lease.familyId} is owned by ${cur.writerId}@${String(cur.epoch)}`,
    );
  }
}
