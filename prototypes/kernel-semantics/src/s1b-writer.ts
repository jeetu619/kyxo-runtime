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
import { canonical } from './storage.ts';

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
 * The bytes a record's MAC covers.
 *
 * Binds the record to its family, its writer, its epoch and its position. That binding is
 * what makes a *genuine* record stolen from another execution, another fork, or an earlier
 * epoch fail verification — replay of a valid record is the attack the S1 format could not
 * see, because its checksum covered only the record's own contents.
 */
export function macPreimage(rec: {
  commitToken: string; executionId: string; familyId: string;
  writerId: string; epoch: number; formatVersion: string; events: unknown;
}): string {
  return canonical({
    commitToken: rec.commitToken, executionId: rec.executionId, familyId: rec.familyId,
    writerId: rec.writerId, epoch: rec.epoch, formatVersion: rec.formatVersion, events: rec.events,
  });
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
