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

import { JournalIntegrityError, S1Kernel, verifyS1Record } from '../src/s1-kernel.ts';
import {
  InMemoryWriterRegistry, KeyringSigner, WriterFencedError, AuthenticityError,
  RECORD_CHECKSUM_DOMAIN, RECORD_MAC_DOMAIN,
  assertOwns, envelopeOf, macPreimage, recordChecksum, recordPreimage,
} from '../src/s1b-writer.ts';
import {
  RETIRED_FORMATS, S1B_FORMAT_VERSION, UnsupportedJournalError,
  assertFormatReadable, canInterpret, defaultUpcasters, envelopeFor,
} from '../src/s1b-compat.ts';
import { Storage, canonical, sha } from '../src/storage.ts';
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

/**
 * An attacker with full disk access who re-chains and re-checksums everything.
 *
 * The re-seal goes through the runtime's own `recordChecksum`: the checksum is unkeyed, so
 * a real attacker recomputes it exactly, and a test that re-derives the recipe by hand is
 * only testing whether it guessed the same field list. That is how S1b-1 hid — the hand
 * copy and the writer disagreed about two fields and every attack test still passed.
 */
function forgeAndReseal(storage: Storage, mutate: (payload: string) => string): void {
  const raw = (storage as unknown as { journal: string[] }).journal;
  for (let i = 0; i < raw.length; i += 1) {
    const before = raw[i]!;
    const after = mutate(before);
    if (after === before) continue;
    const rec = JSON.parse(after) as Record<string, unknown>;
    const env = envelopeOf(rec);
    if (env === null) continue;
    raw[i] = JSON.stringify({ ...rec, checksum: recordChecksum(env) });
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
  const env = envelopeOf(stolen)!;

  const verified = signer.verify(
    macPreimage({ ...env, executionId: 'exec_someone_else' }),   // <- re-attributed
    stolen['mac'] as string, stolen['keyId'] as string,
  );
  assert.equal(verified, false, 'a record cannot be moved between executions');
});

test('A3: an epoch-7 record replayed under epoch 8 is detected', async () => {
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;
  const rec = JSON.parse(raw[raw.length - 1]!) as Record<string, unknown>;
  const env = envelopeOf(rec)!;

  const verified = signer.verify(
    macPreimage({ ...env, epoch: env.epoch + 1 }),          // <- replayed under a later epoch
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
  rec['checksum'] = recordChecksum(envelopeOf(rec)!);       // a correctly sealed future record
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

// ---------------------------------------------------------------------------
// PART 5 × PART 6 — the seals cover the interpretation instructions (S1b-1)
// ---------------------------------------------------------------------------
//
// PART 6 is only as strong as the field it is written in. `mustUnderstand` is the whole of
// the fail-closed rule — it is the writer telling a future reader "if you do not understand
// this kind, STOP" — and it sat outside both seals: outside the MAC, so storage holding no
// key could edit it and the signature still verified, and outside the checksum, so a
// keyless journal had nothing checking it at all.
//
// The consequence is not abstract. It is F-38 reopened through the MAC gap: the old reader
// meets a revision it does not implement, has been told the record is ignorable by someone
// who was not the writer, skips a landing, and the card is charged a second time with every
// check green.

/**
 * A revision-2027 writer, mid rolling upgrade: the new nodes rename `effect.landed` to
 * `world.landed`, and — because they are legitimate writers holding the operator's key —
 * they re-chain and re-sign everything. The journal is GENUINE. What makes it dangerous is
 * only that an old node may still read it, which is the ordinary state of a fleet during a
 * deploy.
 *
 * `requiredFeatures` is left alone deliberately: this is the case where `mustUnderstand` is
 * the only thing standing between an old reader and a lost landing.
 */
function rewriteAsFutureRevision(storage: Storage, signer?: KeyringSigner): void {
  const raw = (storage as unknown as { journal: string[] }).journal;
  const tip = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 1) {
    const rec = JSON.parse(raw[i]!) as Record<string, unknown>;
    const events = rec['events'] as Record<string, unknown>[];
    for (const ev of events) {
      if (ev['kind'] === 'effect.landed') ev['kind'] = 'world.landed';
      const execId = ev['executionId'] as string;
      const prev = tip.get(execId) ?? 'genesis';
      const { payload: _p, integrity: _i, ...rest } = ev;
      const self = sha({ ...rest, prev });
      ev['integrity'] = { prev, self };
      tip.set(execId, self);
    }
    rec['formatVersion'] = '2027-01-01';
    rec['mustUnderstand'] = [...new Set(
      (rec['mustUnderstand'] as string[]).map((k) => (k === 'effect.landed' ? 'world.landed' : k)),
    )].sort();
    const env = envelopeOf(rec)!;
    rec['checksum'] = recordChecksum(env);
    if (signer !== undefined) rec['mac'] = signer.sign(macPreimage(env));
    raw[i] = JSON.stringify(rec);
  }
}

/** The index of the record carrying the (renamed) landing. Mid-journal, by construction. */
function landingRecord(storage: Storage): { index: number; rec: Record<string, unknown> } {
  const raw = (storage as unknown as { journal: string[] }).journal;
  const index = raw.findIndex((l) => l.includes('"world.landed"'));
  assert.ok(index >= 0 && index < raw.length - 1, 'the landing must be mid-journal for this test');
  return { index, rec: JSON.parse(raw[index]!) as Record<string, unknown> };
}

test('E1: an unimplemented revision is refused — the control for the strip attack', async () => {
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  rewriteAsFutureRevision(storage, signer);

  assert.throws(
    () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof UnsupportedJournalError && /must-understand/.test((e as Error).message),
    'an authentic journal from a revision this reader does not implement must stop it',
  );
});

test('E2: storage CANNOT disarm must-understand — the MAC covers it (S1b-1)', async () => {
  // THE REGRESSION. Before the envelope was unified this attack succeeded completely:
  // `mustUnderstand` was outside `macPreimage`, so an attacker with no key at all edited
  // one array, recomputed the unkeyed checksum, left the MAC untouched, and authenticated
  // recovery accepted the record. The landing then vanished into "unknown optional kind"
  // and the retry charged the card again.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  rewriteAsFutureRevision(storage, signer);

  const raw = (storage as unknown as { journal: string[] }).journal;
  const { index, rec } = landingRecord(storage);
  rec['mustUnderstand'] = (rec['mustUnderstand'] as string[]).filter((k) => k !== 'world.landed');
  // The checksum is unkeyed, so a real attacker recomputes it correctly. Only the MAC can
  // tell the difference, which is exactly why the field has to be inside the MAC and not
  // merely inside the checksum.
  rec['checksum'] = recordChecksum(envelopeOf(rec)!);
  raw[index] = JSON.stringify(rec);

  // The edit really does disarm the fail-closed layer: with the instruction gone, the gate
  // that exists to stop this reader waves the record through as an ignorable unknown.
  assert.equal(
    canInterpret(rec as never, rec['events'] as never, upcasters).ok, true,
    'the strip works — PART 6 alone no longer refuses this record',
  );
  assert.equal(
    verifyS1Record(rec), true,
    'and the unkeyed seal is satisfied — an attacker who knows the recipe recomputes it',
  );

  // So the MAC is the only thing left, and it must hold.
  await assert.rejects(
    async () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof AuthenticityError,
    'editing the interpretation instructions must break authentication',
  );
});

test('E3: a keyless journal detects the strip too — the checksum covers it (S1b-1)', async () => {
  // Not every journal has a signer, and the field most likely to be lost is one a middlebox
  // does not recognise: a proxy that normalises JSON, a serializer that drops empty-looking
  // arrays, a replication tool written against last year's schema. None of those recompute
  // anything. Under an envelope-blind checksum the record stayed valid and the reader was
  // silently disarmed; now the seal it did not touch refuses it.
  const card = new Card();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(card));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});
  rewriteAsFutureRevision(storage);

  const raw = (storage as unknown as { journal: string[] }).journal;
  const { index, rec } = landingRecord(storage);
  delete rec['mustUnderstand'];                             // dropped, not edited
  raw[index] = JSON.stringify(rec);

  // The verifier REFUSES rather than answering "invalid". Answering "invalid" is what a
  // reader says about an interrupted write, and this record parsed — every one of its bytes
  // reached the disk and something removed a field afterwards. E7 below is what that
  // distinction is worth.
  assert.throws(
    () => verifyS1Record(rec),
    (e: unknown) => e instanceof JournalIntegrityError && /mustUnderstand/.test((e as Error).message),
    'a record missing an envelope field is malformed, and malformed is not torn',
  );
  assert.throws(
    () => S1Kernel.recover(storage, [payer(card)]),
    (e: unknown) => e instanceof JournalIntegrityError,
    'a keyless reader must still refuse a journal whose instructions were rewritten',
  );
});

test('E4: requiredFeatures cannot be stripped either (S1b-1)', async () => {
  // The mirror of C6. C6 proves an unknown feature bit stops this reader; this proves the
  // bit cannot simply be removed by whoever holds the disk. A feature bit that an attacker
  // can delete is a feature bit that protects nothing.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;

  // A legitimate future writer requires an anchor feature this reader does not implement.
  const rec = JSON.parse(raw[raw.length - 2]!) as Record<string, unknown>;
  rec['requiredFeatures'] = [...(rec['requiredFeatures'] as string[]), 'journal-anchor/1'].sort();
  rec['checksum'] = recordChecksum(envelopeOf(rec)!);
  rec['mac'] = signer.sign(macPreimage(envelopeOf(rec)!));
  raw[raw.length - 2] = JSON.stringify(rec);

  assert.throws(
    () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof UnsupportedJournalError,
    'the reader stops on a feature it does not implement',
  );

  // Now storage removes the bit and re-seals what it can.
  rec['requiredFeatures'] = (rec['requiredFeatures'] as string[]).filter((f) => f !== 'journal-anchor/1');
  rec['checksum'] = recordChecksum(envelopeOf(rec)!);
  raw[raw.length - 2] = JSON.stringify(rec);

  await assert.rejects(
    async () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof AuthenticityError,
    'removing a required feature must break authentication, not silently downgrade the reader',
  );
});

test('E5: the checksum and the MAC are domain-separated', async () => {
  // Two seals over the same envelope must not produce interchangeable bytes. Without a
  // domain tag, any future mechanism that signs a canonical envelope with the journal key
  // — the per-family tip Blocker 2 needs, a checkpoint seal, a revocation record — yields
  // signatures that are also valid commit-record MACs.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;
  const rec = JSON.parse(raw[raw.length - 1]!) as Record<string, unknown>;
  const env = envelopeOf(rec)!;

  const asChecksum = recordPreimage(RECORD_CHECKSUM_DOMAIN, env);
  const asMac = recordPreimage(RECORD_MAC_DOMAIN, env);
  assert.notEqual(asChecksum, asMac, 'the same envelope must not hash the same for two purposes');
  assert.ok(asMac.includes(RECORD_MAC_DOMAIN), 'the purpose travels inside the preimage');

  // A signature minted for the other purpose is not a record MAC.
  assert.equal(
    signer.verify(macPreimage(env), signer.sign(asChecksum), signer.keyId), false,
    'a seal from one domain must not verify in another',
  );
  // And the domain is inside the canonical structure, not a movable prefix on a string.
  assert.equal(
    signer.verify(macPreimage(env), signer.sign(RECORD_MAC_DOMAIN + asChecksum), signer.keyId), false,
  );
});

test('E6: every envelope field on disk is under both seals — no field is exempt', async () => {
  // The self-maintaining half of the fix. S1b-1 happened because the field list lived in
  // two hand-written copies that drifted; this walks the fields that are ACTUALLY on disk
  // and requires each one to be sealed, so a field added to the record later cannot quietly
  // arrive unauthenticated. Only the seals themselves and the key selector are exempt.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  const raw = (storage as unknown as { journal: string[] }).journal;
  const rec = JSON.parse(raw[raw.length - 1]!) as Record<string, unknown>;
  const exempt = new Set(['checksum', 'mac', 'keyId']);

  const fields = Object.keys(rec).filter((k) => !exempt.has(k));
  assert.ok(fields.length >= 9, `expected the full envelope on disk, saw ${fields.join(',')}`);

  for (const field of fields) {
    const v = rec[field];
    const mutated: unknown =
      typeof v === 'string' ? `${v}-tampered`
        : typeof v === 'number' ? v + 1
          : Array.isArray(v) ? [...v, 'tampered']
            : undefined;
    assert.notEqual(mutated, undefined, `no mutation strategy for ${field}`);
    const tampered = { ...rec, [field]: mutated };

    assert.equal(verifyS1Record(tampered), false, `${field} must be under the checksum`);
    assert.equal(
      signer.verify(macPreimage(envelopeOf(tampered)!), rec['mac'] as string, rec['keyId'] as string),
      false, `${field} must be under the MAC`,
    );
  }
});

// ---------------------------------------------------------------------------
// E7–E9 — MALFORMED IS NOT TORN (S1b-1 review 7)
// ---------------------------------------------------------------------------
//
// E2 and E3 proved a stripped record is caught. They proved it, it turned out, only for a
// record in the MIDDLE of a journal: the refusal arrived through `corruptionInMiddle`,
// which by definition only trips when a VALID record follows a bad one. The verifier itself
// answered `false`, and `false` is the answer that means "interrupted write".
//
// So the attack survived by moving. Strip the LAST record of a journal and the reader saw a
// clean, shorter journal and folded it. Strip the only record and the reader saw an empty
// one and recovered an empty kernel. Both silent, both leaving the next run to repeat every
// claim, landing and settlement it could no longer see — and the record it dropped is the
// one whose `mustUnderstand` said "you may not skip me".
//
// The fix is the distinction the format was missing, not a new check bolted onto recovery:
//
//   TORN       the bytes are INCOMPLETE. The write died mid-append, the line does not parse,
//              nothing was committed. Discarding it is correct and stays correct (E9).
//   MALFORMED  the line PARSED, so a whole record reached the disk and was then altered.
//              That is not an interrupted write and must never be answered like one.

/**
 * The verifier exactly as it stood BEFORE this fix: an envelope fault answered `false`.
 *
 * Carried here as a fixture rather than described in a comment, so the tests below can
 * assert what the old reader actually saw. A regression test that cannot show the damage it
 * prevents is a test that will be deleted by whoever next finds it inconvenient.
 */
function verifyAsPreFixReader(record: unknown): boolean {
  const env = envelopeOf(record);
  if (env === null) return false;
  return (record as { checksum?: unknown }).checksum === recordChecksum(env);
}

/** Delete one field from a journal line, leaving every other byte alone. */
function stripField(storage: Storage, index: number, field: string): void {
  const raw = (storage as unknown as { journal: string[] }).journal;
  const rec = JSON.parse(raw[index]!) as Record<string, unknown>;
  assert.ok(field in rec, `the writer must have emitted ${field} for this test to mean anything`);
  delete rec[field];
  raw[index] = JSON.stringify(rec);
}

/** A journal whose LAST record is the settlement of a real charge. Signed or not. */
async function paymentJournal(card: Card, signed: boolean): Promise<{
  storage: Storage; signer?: KeyringSigner;
}> {
  if (signed) {
    const { storage, signer } = await signedJournal(card);
    return { storage, signer };
  }
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(card));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});
  return { storage };
}

/** A journal with exactly ONE commit record. Signed or not. */
function singleRecordJournal(signed: boolean): { storage: Storage; signer?: KeyringSigner } {
  const storage = new Storage();
  if (!signed) {
    new S1Kernel(storage).createExecution();
    return { storage };
  }
  const signer = new KeyringSigner('k1', 'secret-one');
  const k = new S1Kernel(storage, { registry: new InMemoryWriterRegistry(), signer, writerId: 'writer-A' });
  k.createExecution();
  return { storage, signer };
}

/** The interpretation-critical fields. Removing either one disarms the reader. */
const INTERPRETATION_FIELDS = ['mustUnderstand', 'requiredFeatures'] as const;

for (const field of INTERPRETATION_FIELDS) {
  for (const signed of [false, true]) {
    const how = signed ? 'signed' : 'signerless';

    test(`E7 (${how}): deleting ${field} from the TRAILING record REFUSES recovery`, async () => {
      const card = new Card();
      const { storage, signer } = await paymentJournal(card, signed);
      const raw = (storage as unknown as { journal: string[] }).journal;
      const before = raw.length;
      assert.ok(before > 1, 'the stripped record must be the last of several, not the only one');

      stripField(storage, before - 1, field);

      // THE DAMAGE, STATED AS AN ASSERTION. To the pre-fix reader this journal was not
      // damaged at all: one trailing record failed, nothing followed it to mark the failure
      // as corruption, and what remained was a shorter journal that verified end to end.
      const asPreFixReaderSaw = storage.readJournal(verifyAsPreFixReader);
      assert.equal(asPreFixReaderSaw.discarded, 1);
      assert.equal(asPreFixReaderSaw.corruptionInMiddle, false, 'nothing flags it — it is trailing');
      assert.equal(asPreFixReaderSaw.records.length, before - 1, 'the old reader saw a clean prefix');

      // The real runtime path must refuse instead. Not a helper, not the verifier in
      // isolation: Storage.readJournal -> S1Kernel.recover.
      assert.throws(
        () => S1Kernel.recover(storage, [payer(card)], signer === undefined ? {} : { signer }),
        (e: unknown) => e instanceof JournalIntegrityError
          && new RegExp(`malformed.*${field}`, 's').test((e as Error).message),
        'a record that parsed and lost its interpretation instructions is not an interrupted write',
      );
      assert.equal(card.charges, 1, 'and the charge it already made is not repeated');
    });

    test(`E8 (${how}): deleting ${field} from the ONLY record REFUSES recovery`, () => {
      const { storage, signer } = singleRecordJournal(signed);
      const raw = (storage as unknown as { journal: string[] }).journal;
      assert.equal(raw.length, 1, 'this test is about the case with nothing to compare against');

      stripField(storage, 0, field);

      // Worse than the trailing case and quieter: with no valid record anywhere, the pre-fix
      // reader saw an EMPTY journal — indistinguishable from a runtime that had never run —
      // and recovery returned an empty kernel. Every protection the journal held was gone
      // and nothing said so.
      const asPreFixReaderSaw = storage.readJournal(verifyAsPreFixReader);
      assert.equal(asPreFixReaderSaw.records.length, 0, 'the old reader saw nothing at all');
      assert.equal(asPreFixReaderSaw.corruptionInMiddle, false, 'and had nothing to flag');

      assert.throws(
        () => S1Kernel.recover(storage, [], signer === undefined ? {} : { signer }),
        (e: unknown) => e instanceof JournalIntegrityError
          && new RegExp(`malformed.*${field}`, 's').test((e as Error).message),
        'an empty kernel and a stripped journal must not look the same',
      );
    });
  }
}

test('E9: a GENUINELY torn trailing write is still just discarded — the semantics survive', async () => {
  // The control, and the reason E7/E8 refuse on parse-success rather than on "the verifier
  // said no". Crash recovery depends on a half-written trailing record being discardable; a
  // fix that took that away would trade a silent data-loss bug for a runtime that cannot
  // restart after any crash. The two cases are told apart by whether the bytes PARSE, which
  // is a property of the write, not a judgement about the writer.
  const card = new Card();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(card));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});

  const raw = (storage as unknown as { journal: string[] }).journal;
  const whole = raw.length;
  storage.armCrash(storage.writes + 1, { torn: true, label: 'torn' });
  await assert.rejects(() => k.invoke(exec, 'pay', { invoiceId: 'I2' }, grant, {}));
  storage.disarm();
  assert.equal(raw.length, whole + 1, 'the torn line reached the disk');
  assert.throws(() => JSON.parse(raw[raw.length - 1]!), 'and it is incomplete: it does not parse');

  const read = storage.readJournal(verifyS1Record);
  assert.equal(read.discarded, 1, 'a torn line is discarded, not refused');
  assert.equal(read.records.length, whole, 'and everything committed before it survives');

  const { kernel } = S1Kernel.recover(storage, [payer(card)]);
  assert.ok(kernel.familyIds().length === 1, 'recovery proceeds — this is ordinary crash recovery');
});

test('E10: the record is refused through EVERY read path, not only recover()', async () => {
  // Doc 31 §2 again: a refusal counts only if it is structurally on the runtime path. It
  // lives in the verifier every reader passes through, so `events()` refuses the same
  // journal `recover()` refuses — a reader added later cannot forget it.
  const card = new Card();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(card));
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});

  const raw = (storage as unknown as { journal: string[] }).journal;
  stripField(storage, raw.length - 1, 'mustUnderstand');

  assert.throws(() => S1Kernel.recover(storage, [payer(card)]), JournalIntegrityError);
  assert.throws(() => k.events(familyId), JournalIntegrityError);
});

test('E11: quarantine does NOT downgrade a malformed record into a discardable one', async () => {
  // Quarantine is the operator saying "recover what is readable, I accept the loss" — and it
  // is honest only because recovery can then say exactly what was dropped and what that cost
  // (the invariant report at the end of `recover`). A record whose interpretation
  // instructions were removed cannot say what dropping it would cost; that is precisely the
  // property that was taken from it. So it is refused under quarantine too, the same answer
  // a retired format gets, and the operator's path is to repair or convert it deliberately.
  const card = new Card();
  const { storage } = await paymentJournal(card, false);
  const raw = (storage as unknown as { journal: string[] }).journal;
  stripField(storage, raw.length - 1, 'mustUnderstand');

  assert.throws(
    () => S1Kernel.recover(storage, [payer(card)], { quarantine: true }),
    (e: unknown) => e instanceof JournalIntegrityError && /malformed/.test((e as Error).message),
    'quarantine recovers a readable prefix; it does not make an altered record readable',
  );
});

// ---------------------------------------------------------------------------
// PART 19 — the identifier moves when the seal recipe does (S1b-1 follow-up)
// ---------------------------------------------------------------------------
//
// Moving `requiredFeatures` and `mustUnderstand` inside the seals changed no field name and
// no field type, so the change LOOKS additive. It is not. A seal recipe is the rule by which
// a reader decides a record is genuine, and two records with byte-identical fields now carry
// different checksums depending on which revision wrote them. Left under one identifier,
// `2026-08-18` would name two non-interoperable formats and a reader could not tell which
// rule made the record in front of it.
//
// The identifier therefore moves — the same rule S1b applied at `2026-08-17` → `2026-08-18`,
// and the revision doc 31 §7 named in advance.

const RETIRED_FORMAT = '2026-08-18';

/**
 * Rewrite a journal into what the PRE-FIX `2026-08-18` writer actually produced.
 *
 * Both retired recipes are reproduced here verbatim rather than imported, because that
 * revision's code no longer exists — a fixture for a retired format has to carry the retired
 * rules with it or it is a fixture for nothing. Exactly as they stood before S1b-1:
 *
 *   checksum   sha({commitToken, executionId, familyId, events})
 *   mac        canonical({commitToken, executionId, familyId, writerId, epoch,
 *                         formatVersion, events})
 *
 * What is absent from both is the point: `requiredFeatures` and `mustUnderstand`. That
 * absence IS the retired revision, and it is why no reader can hold both rules at once.
 */
function downgradeToPreFix(storage: Storage, signer?: KeyringSigner): void {
  const raw = (storage as unknown as { journal: string[] }).journal;
  const tip = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 1) {
    const rec = JSON.parse(raw[i]!) as Record<string, unknown>;
    for (const ev of rec['events'] as Record<string, unknown>[]) {
      ev['protocolVersion'] = RETIRED_FORMAT;
      const execId = ev['executionId'] as string;
      const prev = tip.get(execId) ?? 'genesis';
      const { payload: _p, integrity: _i, ...rest } = ev;
      const self = sha({ ...rest, prev });
      ev['integrity'] = { prev, self };
      tip.set(execId, self);
    }
    rec['formatVersion'] = RETIRED_FORMAT;
    const sealed = {
      commitToken: rec['commitToken'], executionId: rec['executionId'],
      familyId: rec['familyId'], events: rec['events'],
    };
    rec['checksum'] = sha(sealed);
    if (signer !== undefined) {
      rec['mac'] = signer.sign(canonical({
        ...sealed,
        writerId: rec['writerId'], epoch: rec['epoch'], formatVersion: rec['formatVersion'],
      }));
    }
    raw[i] = JSON.stringify(rec);
  }
}

test('V1: the seal recipe changed, so the format identifier moved with it', async () => {
  const card = new Card();
  const { storage } = await signedJournal(card);
  const records = storage.readJournal(() => true).records as Record<string, unknown>[];
  assert.ok(records.length > 0);

  for (const rec of records) {
    assert.equal(rec['formatVersion'], '2026-08-19', 'a record names the revision that sealed it');
    // One identifier, stamped twice: on the record and on every event inside it. Both are
    // under seals, so neither is more authoritative than the other and a journal in which
    // they disagree is one no reader can resolve.
    for (const ev of rec['events'] as { protocolVersion: string }[]) {
      assert.equal(ev.protocolVersion, rec['formatVersion'], 'record and events agree');
    }
  }
  assert.equal(S1B_FORMAT_VERSION, '2026-08-19');
  assert.ok(RETIRED_FORMATS.has(RETIRED_FORMAT), 'the recipe it replaced is retired BY NAME, not forgotten');
});

test('V2: a pre-fix 2026-08-18 journal is REFUSED, not silently discarded as torn', async () => {
  // THE VERSIONING REGRESSION. The hazard in a seal-recipe change is not that old records
  // fail — they must — but HOW they fail, and the failure mode here is completely silent.
  const card = new Card();
  const { storage, signer } = await signedJournal(card);
  downgradeToPreFix(storage, signer);

  // Stated as an assertion rather than as a comment: under the current recipe every record
  // in this journal is invalid, and nothing in the journal marks it as corruption, because
  // corruption is only recognised when a VALID record follows a bad one. So a reader that
  // knew nothing about the identifier would discard the entire journal as one long
  // interrupted write, recover an EMPTY kernel, and repeat every claim, landing and
  // settlement in it. storage.ts names this failure once already (F-11).
  const underCurrentRecipe = storage.readJournal((r) => {
    const env = envelopeOf(r);
    return env !== null && (r as { checksum?: unknown }).checksum === recordChecksum(env);
  });
  assert.ok(underCurrentRecipe.discarded > 0);
  assert.equal(underCurrentRecipe.records.length, 0, 'the current recipe rejects every record');
  assert.equal(underCurrentRecipe.corruptionInMiddle, false, 'and nothing flags it as corruption');

  // The identifier is what turns that silence into a decision.
  assert.throws(
    () => S1Kernel.recover(storage, [payer(card)], { signer }),
    (e: unknown) => e instanceof UnsupportedJournalError
      && new RegExp(`retired format '${RETIRED_FORMAT}'`).test((e as Error).message),
    'a journal from the previous revision must stop the reader, by name',
  );
  assert.equal(card.charges, 1, 'and the effect it already performed is not repeated');
});

test('V3: every read path refuses a retired journal, not just recover()', async () => {
  // Doc 31 §2's rule, applied to this mechanism: it counts only if it is structurally on
  // the runtime path. The refusal lives in the verifier every reader must pass through
  // rather than in `canInterpret` — which a retired record never reaches, since it fails
  // the checksum first — so a reader added later cannot forget it. Both existing entry
  // points to the disk prove it.
  const card = new Card();
  const storage = new Storage();
  const registry = new InMemoryWriterRegistry();
  const signer = new KeyringSigner('k1', 'secret-one');
  const k = new S1Kernel(storage, { registry, signer, writerId: 'writer-A' });
  k.register(payer(card));
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'pay', { invoiceId: 'I1' }, grant, {});
  downgradeToPreFix(storage, signer);

  assert.throws(() => S1Kernel.recover(storage, [payer(card)], { signer }), UnsupportedJournalError);
  assert.throws(() => k.events(familyId), UnsupportedJournalError);
});

test('V4: an unknown FUTURE identifier is not refused by name — feature bits still decide', () => {
  // A retired-list, not an allowlist, and the difference is the whole of PART 6. Refusing
  // every identifier this reader has not seen would make `requiredFeatures` and
  // `mustUnderstand` pointless: they exist precisely so a reader can decide whether a future
  // revision changed something it depends on, rather than stopping at a date it does not
  // recognise. E1 is what stops the 2027 journal, and it stops it for a reason it can state.
  assert.doesNotThrow(() => { assertFormatReadable({ formatVersion: '2027-01-01' }); });
  assert.doesNotThrow(() => { assertFormatReadable({ formatVersion: S1B_FORMAT_VERSION }); });
  assert.throws(
    () => { assertFormatReadable({ formatVersion: RETIRED_FORMAT }); },
    (e: unknown) => e instanceof UnsupportedJournalError && /S1b-1/.test((e as Error).message),
    'and the refusal says which revision, and why, not merely "unsupported"',
  );
});
