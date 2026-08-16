/**
 * S1b PARTS 4, 5, 6, 9 — writer fencing, journal authenticity, and reader compatibility.
 *
 * The three format-level gaps the independent review said could not be added after a
 * freeze, because a field absent from records already written cannot be retrofitted into
 * them. Each is tested for the property that matters, not for the mechanism:
 *
 *   fencing        a stale writer cannot append, even holding a valid key
 *   authenticity   storage that rewrites history is detected
 *   compatibility  an old reader cannot silently skip safety-critical semantics
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel } from '../src/s1-kernel.ts';
import {
  InMemoryWriterRegistry, KeyringSigner, WriterFencedError, AuthenticityError,
  assertOwns, macPreimage,
} from '../src/s1b-writer.ts';
import { UnsupportedJournalError, canInterpret, defaultUpcasters, envelopeFor } from '../src/s1b-compat.ts';
import { Storage, sha } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectProposal,
} from '../src/types.ts';

class Card { charges = 0; charge(): void { this.charges += 1; } }

function payer(card: Card): CapabilityProvider {
  return {
    manifest: {
      id: 'pay', version: '1.0.0',
      traits: {
        effectClass: 'external-irreversible', probeable: true, compensatable: false,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'payments.charge', fields: ['invoiceId'] },
    },
    async *invoke(): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      card.charge();
      yield { type: 'external', descriptor: 'charge', landed: true };
      return { status: 'ok', output: {} };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'landed'; },
  };
}

const GRANT = { rights: ['pay'], limits: { invocations: 50, usd: 500 } };

// ---------------------------------------------------------------------------
// PART 4 / PART 9 — writer identity and fencing
// ---------------------------------------------------------------------------

test('W1: records carry writer identity and epoch — the violation is attributable', async () => {
  // S1's format made two writers produce BYTE-IDENTICAL records, so a double charge was
  // indistinguishable from an at-least-once redelivery and a reader deduplicating by
  // commit token was correct to collapse them and wrong about the money.
  const card = new Card();
  const storage = new Storage();
  const registry = new InMemoryWriterRegistry();
  const signer = new KeyringSigner('k1', 'secret-one');

  const k = new S1Kernel(storage, { registry, signer, writerId: 'writer-A' });
  k.register(payer(card));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});

  const recs = storage.readJournal(() => true).records as { writerId?: string; epoch?: number }[];
  const fenced = recs.filter((r) => r.writerId === 'writer-A');
  assert.ok(fenced.length > 0, 'appends after acquisition carry the writer');
  for (const r of fenced) assert.equal(r.epoch, 1);
});

test('W2: an old writer that wakes after takeover CANNOT append, holding a valid key', async () => {
  // THE fencing test, and PART 9's point: the stale writer is cryptographically valid.
  // Authentication is not authorization.
  const card = new Card();
  const storage = new Storage();
  const registry = new InMemoryWriterRegistry();
  const signer = new KeyringSigner('k1', 'secret-one');

  const kA = new S1Kernel(storage, { registry, signer, writerId: 'writer-A' });
  kA.register(payer(card));
  const exec = kA.createExecution();
  const familyId = kA.familyFor(exec).familyId;
  const leaseA = kA.writerLease()!;
  const grant = kA.issueGrant(exec, GRANT);
  assert.equal(leaseA.epoch, 1);

  // A pauses. B recovers the family and takes ownership.
  const { kernel: kB } = S1Kernel.recover(storage, [payer(card)]);
  const leaseB = kB.acquireWriter(familyId, registry, signer, 'writer-B');
  assert.equal(leaseB.epoch, 2, 'takeover bumps the epoch');

  // A wakes up and tries to do exactly what it was doing.
  await assert.rejects(
    () => kA.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {}),
    (e: unknown) => e instanceof WriterFencedError && /stale/.test(e.message),
    'a superseded writer must not append authoritative records',
  );
  assert.equal(card.charges, 0, 'and must not touch the world on the way');
});

test('W3: the fence is checked per append, not once at acquisition', async () => {
  // A writer that was legitimate when it started can be superseded mid-flight. Checking
  // ownership only at acquisition would make the window between acquisition and the last
  // append unfenced — which is most of the writer's life.
  const registry = new InMemoryWriterRegistry();
  const lease = registry.acquire('fam-1', 'writer-A' as never, 0);
  assertOwns(registry, { ...lease, keyId: 'k1' });          // fine now

  registry.acquire('fam-1', 'writer-B' as never, lease.epoch);
  assert.throws(
    () => assertOwns(registry, { ...lease, keyId: 'k1' }),
    (e: unknown) => e instanceof WriterFencedError,
  );
});

test('W4: acquisition is compare-and-set — a writer with a stale view cannot take over', async () => {
  const registry = new InMemoryWriterRegistry();
  registry.acquire('fam-1', 'writer-A' as never, 0);        // epoch 1
  registry.acquire('fam-1', 'writer-B' as never, 1);        // epoch 2

  // C still believes epoch 1 is current — the classic split-brain view.
  assert.throws(
    () => registry.acquire('fam-1', 'writer-C' as never, 1),
    (e: unknown) => e instanceof WriterFencedError && /expected epoch/.test(e.message),
    'ownership transfer requires a correct view of the current epoch',
  );
});

// ---------------------------------------------------------------------------
// PART 5 — journal authenticity
// ---------------------------------------------------------------------------

async function signedJournal(card: Card): Promise<{ storage: Storage; signer: KeyringSigner; exec: never }> {
  const storage = new Storage();
  const registry = new InMemoryWriterRegistry();
  const signer = new KeyringSigner('k1', 'secret-one');
  const k = new S1Kernel(storage, { registry, signer, writerId: 'writer-A' });
  k.register(payer(card));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});
  return { storage, signer, exec: exec as never };
}

/** An attacker with full disk access who re-chains and re-checksums everything. */
function forgeAndReseal(storage: Storage, mutate: (payload: string) => string): void {
  const raw = (storage as unknown as { journal: string[] }).journal;
  for (let i = 0; i < raw.length; i += 1) {
    const before = raw[i]!;
    const after = mutate(before);
    if (after === before) continue;
    const rec = JSON.parse(after) as { commitToken: string; executionId: string; familyId: string; events: unknown };
    raw[i] = JSON.stringify({
      ...(JSON.parse(after) as object),
      checksum: sha({ commitToken: rec.commitToken, executionId: rec.executionId, familyId: rec.familyId, events: rec.events }),
    });
  }
}

test('A1: storage that rewrites a payload and re-seals every hash is DETECTED', async () => {
  // S1's chain was unkeyed, so an attacker with disk access recomputed payloadHash, the
  // whole prev/self chain and the record checksum, and every check passed. A MAC over a
  // preimage the attacker cannot produce is the difference.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  forgeAndReseal(storage, (line) => line.replace('"invoiceId":"I1"', '"invoiceId":"I-STOLEN"'));

  await assert.rejects(
    async () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof AuthenticityError,
    'a re-sealed forgery must fail authentication',
  );
});

test('A2: a genuine record replayed into ANOTHER execution is detected', async () => {
  // The MAC preimage binds family, writer, epoch and execution, so a valid record lifted
  // from elsewhere does not verify here. S1's checksum covered only the record itself.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;
  const stolen = JSON.parse(raw[raw.length - 1]!) as Record<string, unknown>;

  const verified = signer.verify(
    macPreimage({
      commitToken: stolen['commitToken'] as string,
      executionId: 'exec_someone_else',                     // <- re-attributed
      familyId: stolen['familyId'] as string,
      writerId: stolen['writerId'] as string,
      epoch: stolen['epoch'] as number,
      formatVersion: stolen['formatVersion'] as string,
      events: stolen['events'],
    }),
    stolen['mac'] as string, stolen['keyId'] as string,
  );
  assert.equal(verified, false, 'a record cannot be moved between executions');
});

test('A3: an epoch-7 record replayed under epoch 8 is detected', async () => {
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;
  const rec = JSON.parse(raw[raw.length - 1]!) as Record<string, unknown>;

  const verified = signer.verify(
    macPreimage({
      commitToken: rec['commitToken'] as string, executionId: rec['executionId'] as string,
      familyId: rec['familyId'] as string, writerId: rec['writerId'] as string,
      epoch: (rec['epoch'] as number) + 1,                  // <- replayed under a later epoch
      formatVersion: rec['formatVersion'] as string, events: rec['events'],
    }),
    rec['mac'] as string, rec['keyId'] as string,
  );
  assert.equal(verified, false, 'the epoch is inside the preimage, so a replay across epochs fails');
});

test('A4: key rotation keeps old records verifiable; revocation does not', async () => {
  // Rotation is not a migration: each record names the key that signed it, so a retired
  // key stays in the keyring for verification while a new key signs new records.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  signer.rotate('k2', 'secret-two');
  const { kernel } = S1Kernel.recover(storage, [payer(card)], { signer });
  assert.ok(kernel.familyIds().length > 0, 'records signed with the retired key still verify');

  // Compromise: the key is removed, and records it signed stop verifying — deliberately.
  signer.revoke('k1');
  await assert.rejects(
    async () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof AuthenticityError,
  );
});

test('A5: an unverifiable journal is recoverable ONLY by explicit operator decision', async () => {
  // Key loss must not mean data loss, and it must not silently look like a clean read.
  // "We could not check" and "we checked and it was fine" have to be distinguishable.
  const card = new Card();
  const { storage } = await signedJournal(card);
  const wrongKey = new KeyringSigner('k9', 'not-the-key');

  await assert.rejects(
    async () => S1Kernel.recover(storage, [payer(card)], { signer: wrongKey }),
    (e: unknown) => e instanceof AuthenticityError,
  );
  const { kernel } = S1Kernel.recover(storage, [payer(card)], { signer: wrongKey, acceptUnverifiable: true });
  assert.ok(kernel.familyIds().length > 0, 'recovery is available, as a decision');
});

test('A6: no signing authority reaches a capability or a consumer', async () => {
  // A capability that could sign could forge history. Nothing in the invocation context,
  // the manifest surface or the kernel's public API exposes a key or a signer.
  const src = (await import('node:fs')).readFileSync(
    new URL('../src/s1-kernel.ts', import.meta.url), 'utf8');
  const ctxBlock = src.slice(src.indexOf('const ctx = {'), src.indexOf('let result:'));
  for (const forbidden of ['signer', 'keyId', 'sign(', 'lease']) {
    assert.ok(!ctxBlock.includes(forbidden), `InvokeCtx must not expose ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// PART 6 — must-understand reader semantics
// ---------------------------------------------------------------------------

const upcasters = defaultUpcasters();

test('C1: an unknown OPTIONAL kind is skippable', () => {
  const env = envelopeFor(['state.updated']);
  const verdict = canInterpret(env, [{ kind: 'telemetry.sampled.v9', schemaVersion: 1 }], upcasters);
  assert.equal(verdict.ok, true, 'forward compatibility is preserved where it is safe');
});

test('C2: an unknown REQUIRED kind FAILS CLOSED — the S1 double-charge path', () => {
  // A future revision renames effect.landed to world.landed and marks it must-understand.
  // S1 read it as a no-op: the landing vanished, protection never engaged, the card was
  // charged again, invariants green. Criticality now travels with the record.
  const verdict = canInterpret(
    { formatVersion: '2027-01-01', requiredFeatures: [], mustUnderstand: ['world.landed'] },
    [{ kind: 'world.landed', schemaVersion: 1 }],
    upcasters,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /must-understand/);
});

test('C3: an unknown FEATURE bit fails closed even when every kind is familiar', () => {
  // A feature bit can change what a FAMILIAR kind means — the case per-kind negotiation
  // cannot see.
  const verdict = canInterpret(
    { formatVersion: '2027-01-01', requiredFeatures: ['effect-identity/2'], mustUnderstand: [] },
    [{ kind: 'effect.landed', schemaVersion: 1 }],
    upcasters,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /feature/);
});

test('C4: a newer schema for a known kind needs an upcaster, or fails closed', () => {
  const bad = canInterpret(envelopeFor(['effect.landed']), [{ kind: 'effect.landed', schemaVersion: 3 }], upcasters);
  assert.equal(bad.ok, false, 'a reader must never apply a payload whose shape it is guessing at');

  const r = defaultUpcasters();
  r.register('effect.landed', 3, (p) => ({ ...p, effectKey: p['key'] ?? p['effectKey'] }));
  const good = canInterpret(envelopeFor(['effect.landed']), [{ kind: 'effect.landed', schemaVersion: 3 }], r);
  assert.equal(good.ok, true, 'with a declared conversion it is safe');
});

test('C5: a record with no compatibility envelope is refused, not assumed safe', () => {
  // Pre-S1b records predate must-understand. Reading them is an explicit act, not a default.
  const verdict = canInterpret({}, [{ kind: 'effect.landed', schemaVersion: 1 }], upcasters);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /no formatVersion/);
});

test('C6: recovery refuses a journal it cannot safely interpret', async () => {
  // The rule is on the runtime path, not in a validator nobody calls — the S1 lesson.
  const card = new Card();
  const { storage } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;
  const rec = JSON.parse(raw[raw.length - 1]!) as Record<string, unknown>;
  rec['requiredFeatures'] = ['effect-identity/99'];
  rec['checksum'] = sha({
    commitToken: rec['commitToken'], executionId: rec['executionId'],
    familyId: rec['familyId'], events: rec['events'],
  });
  raw[raw.length - 1] = JSON.stringify(rec);

  assert.throws(
    () => S1Kernel.recover(storage, [payer(card)]),
    (e: unknown) => e instanceof UnsupportedJournalError,
    'an old reader must stop rather than silently omit semantics',
  );
});

test('C7: the must-understand set covers everything that protects effects or authority', () => {
  // The test is not "is this kind important?" but "could skipping it produce a WRONG and
  // DANGEROUS conclusion?" This pins the answer so a later revision cannot quietly demote
  // a safety-critical kind to optional.
  const env = envelopeFor([
    'effect.landed', 'effect.claimed', 'grant.issued', 'grant.revoked',
    'invocation.uncertain', 'execution.forked', 'state.updated', 'artifact.produced',
  ]);
  for (const critical of ['effect.landed', 'effect.claimed', 'grant.issued', 'grant.revoked',
    'invocation.uncertain', 'execution.forked']) {
    assert.ok(env.mustUnderstand.includes(critical), `${critical} must be must-understand`);
  }
  for (const advisory of ['state.updated', 'artifact.produced']) {
    assert.ok(!env.mustUnderstand.includes(advisory), `${advisory} need not be`);
  }
});
