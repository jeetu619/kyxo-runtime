/**
 * B8 — payloadHash, redaction, tamper detection, and record-format versioning.
 *
 * B8's finding was that the specification claimed properties the format could not
 * support. Redaction-by-tombstone requires the payload hash to be in the hash preimage,
 * and there was none, so redacting a payload broke the chain and there was no way to tell
 * a lawful redaction from tampering.
 *
 * The revision: every event carries `payloadHash`, and the chain covers the HASH rather
 * than the payload. A payload can therefore be replaced by a tombstone while the chain
 * still verifies — and separately, a payload that is altered without updating the hash is
 * detectable, which is exactly the distinction the old format could not draw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, verifyS1Record } from '../src/s1-kernel.ts';
import { digest, foldAll } from '../src/s1-fold.ts';
import { S1_PROTOCOL_VERSION } from '../src/s1-types.ts';
import type { FamilyId, S1Event } from '../src/s1-types.ts';
import { Storage, canonical, sha } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectProposal, InvokeCtx,
} from '../src/types.ts';

function noteTaker(): CapabilityProvider {
  return {
    manifest: {
      id: 'notes.write', version: '1.0.0',
      traits: {
        effectClass: 'local', probeable: false, compensatable: false, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as { secret?: string };
      yield { type: 'state', key: 'note', value: req.secret ?? 'none' };
      return { status: 'ok', output: { written: true } };
    },
  };
}

function setup(): {
  k: S1Kernel; storage: Storage; exec: ReturnType<S1Kernel['createExecution']>;
  grant: ReturnType<S1Kernel['issueGrant']>; familyId: FamilyId;
} {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(noteTaker());
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, { rights: ['write'], limits: { invocations: 20 } });
  return { k, storage, exec, grant, familyId: k.familyFor(exec).familyId };
}

/** Recompute an event's self hash exactly as the kernel does: over everything but payload. */
function selfHashOf(ev: S1Event): string {
  const { payload: _omit, integrity, ...rest } = ev as S1Event & Record<string, unknown>;
  return sha({ ...rest, prev: integrity.prev });
}

/** Verify the whole chain for one execution: links, self hashes, and payload hashes. */
function verifyChain(events: readonly S1Event[]): { ok: boolean; reason?: string } {
  let prev = 'genesis';
  for (const ev of events) {
    if (ev.integrity.prev !== prev) return { ok: false, reason: `broken link at seq ${ev.seq}` };
    if (selfHashOf(ev) !== ev.integrity.self) return { ok: false, reason: `bad self hash at seq ${ev.seq}` };
    prev = ev.integrity.self;
  }
  return { ok: true };
}

/** Does each payload still match the hash the chain committed to? */
function verifyPayloads(events: readonly S1Event[]): { intact: number; redacted: number; tampered: number } {
  let intact = 0; let redacted = 0; let tampered = 0;
  for (const ev of events) {
    if ((ev.payload as { redacted?: boolean }).redacted === true) { redacted += 1; continue; }
    if (sha(canonical(ev.payload)) === ev.payloadHash) intact += 1;
    else tampered += 1;
  }
  return { intact, redacted, tampered };
}

// ---------------------------------------------------------------------------
// I1 — the envelope
// ---------------------------------------------------------------------------

test('B8/I1: every event carries a payload hash and a version', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'hunter2' }, f.grant, { step: 'a' });

  const events = f.k.events(f.familyId);
  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(typeof ev.payloadHash, 'string');
    assert.equal(ev.payloadHash, sha(canonical(ev.payload)), `payloadHash must match at seq ${ev.seq}`);
    assert.equal(ev.protocolVersion, S1_PROTOCOL_VERSION);
    assert.equal(typeof ev.schemaVersion, 'number');
    assert.equal(ev.actorId, 'kernel', 'actorId is stamped kernel-side, never writer-supplied');
  }
  assert.equal(verifyChain(events).ok, true);
});

// ---------------------------------------------------------------------------
// I2 — redaction, the property the old format could not support
// ---------------------------------------------------------------------------

test('B8/I2: a payload can be redacted without breaking the chain', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'hunter2' }, f.grant, { step: 'a' });

  const events = f.k.events(f.familyId);
  assert.equal(verifyChain(events).ok, true, 'baseline chain must verify');

  // A subject-erasure request arrives. Replace the payload with a tombstone, keeping the
  // hash — the chain covers the hash, so it is undisturbed.
  const carrying = events.filter((e) => canonical(e.payload).includes('hunter2'));

  // REDACTION IS NOT A SINGLE-EVENT OPERATION IN THIS FORMAT (docs/20 F-17). The same
  // datum appears in more than one payload: `invocation.admitted` carries the request so
  // a suspended invocation can be re-entered from a cold start, and `state.updated`
  // carries what was derived from it. Erasure must therefore find every event carrying
  // the datum. This assertion exists so the cost stays visible: if a later revision adds
  // another copy, this number changes and someone has to look at it.
  assert.equal(carrying.length, 2, 'the secret is duplicated across the request and the state write');

  const ids = new Set(carrying.map((e) => e.id));
  const redacted: S1Event[] = events.map((e) => (
    ids.has(e.id) ? { ...e, payload: { redacted: true, reason: 'erasure-request' } } : e
  ));

  assert.equal(
    verifyChain(redacted).ok, true,
    'redaction must not break integrity — that is the whole point of hashing the hash',
  );
  assert.equal(JSON.stringify(redacted).includes('hunter2'), false, 'the secret is gone');

  const v = verifyPayloads(redacted);
  assert.equal(v.redacted, 2);
  assert.equal(v.tampered, 0, 'a lawful redaction must not read as tampering');
});

test('B8/I3: tampering is distinguishable from redaction', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'hunter2' }, f.grant, { step: 'a' });
  const events = f.k.events(f.familyId);

  // Silently rewrite a payload, leaving the hash alone. The chain still verifies —
  // by design, since the chain covers the hash — but the payload no longer matches it.
  const target = events.find((e) => e.kind === 'state.updated')!;
  const tampered: S1Event[] = events.map((e) => (
    e.id === target.id ? { ...e, payload: { key: 'note', value: 'innocuous' } } : e
  ));

  assert.equal(verifyChain(tampered).ok, true, 'the chain covers the hash, so it still links');
  const v = verifyPayloads(tampered);
  assert.equal(v.tampered, 1, 'but the payload no longer matches its committed hash');
  assert.equal(v.redacted, 0, 'and it is not claiming to be a redaction');
});

test('B8/I4: rewriting the hash to match a rewritten payload breaks the chain', async () => {
  // The obvious next move for an attacker: change the payload AND its hash. The hash is
  // in the chain preimage, so the self hash no longer matches and the link is broken.
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'hunter2' }, f.grant, { step: 'a' });
  const events = f.k.events(f.familyId);

  const target = events.find((e) => e.kind === 'state.updated')!;
  const forgedPayload = { key: 'note', value: 'innocuous' };
  const forged: S1Event[] = events.map((e) => (
    e.id === target.id
      ? { ...e, payload: forgedPayload, payloadHash: sha(canonical(forgedPayload)) }
      : e
  ));

  const result = verifyChain(forged);
  assert.equal(result.ok, false, 'a consistent forgery must still fail the chain');
  assert.match(result.reason ?? '', /bad self hash|broken link/);
});

// ---------------------------------------------------------------------------
// I5–I7 — record-level integrity
// ---------------------------------------------------------------------------

test('B8/I5: the commit checksum covers the whole record, not just the events', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 's' }, f.grant, { step: 'a' });

  const { records } = f.storage.readJournal(verifyS1Record);
  assert.ok(records.length > 0);
  const rec = records[0] as { commitToken: string; executionId: string; familyId: string; events: unknown; checksum: string };

  // Re-attributing a record to another execution must be detectable. Under an
  // events-only checksum this passed unnoticed (review #2).
  assert.equal(verifyS1Record({ ...rec, executionId: 'exec_someone_else' }), false);
  assert.equal(verifyS1Record({ ...rec, familyId: 'fam_someone_else' }), false);
  assert.equal(verifyS1Record({ ...rec, commitToken: 'ct_replayed' }), false);
  assert.equal(verifyS1Record(rec), true, 'the untouched record still verifies');
});

test('B8/I6: a torn trailing record is discarded, and everything before it survives', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'a' }, f.grant, { step: 'a' });
  const goodCount = f.storage.readJournal(verifyS1Record).records.length;

  f.storage.armCrash(f.storage.writes + 1, { torn: true, label: 'torn' });
  await assert.rejects(() => f.k.invoke(f.exec, 'notes.write', { secret: 'b' }, f.grant, { step: 'b' }));
  f.storage.disarm();

  const after = f.storage.readJournal(verifyS1Record);
  assert.equal(after.discarded, 1, 'the torn record must be discarded');
  assert.equal(after.records.length, goodCount, 'and nothing before it may be lost');

  const { kernel: k2 } = S1Kernel.recover(f.storage, [noteTaker()]);
  assert.equal(verifyChain(k2.events(f.familyId)).ok, true, 'recovery leaves a verifiable chain');
});

test('B8/I7: a record that fails its checksum is never folded', async () => {
  // Storage keeps bytes; the record format decides what is valid. A record whose checksum
  // does not verify must not reach the fold at all — derived state is only ever built from
  // records that passed.
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'a' }, f.grant, { step: 'a' });

  const permissive = f.storage.readJournal(() => true).records.length;
  const strict = f.storage.readJournal(verifyS1Record).records.length;
  assert.equal(permissive, strict, 'no invalid records in a clean journal');

  // The phase-2 verifier must reject S1 records rather than silently accepting them:
  // two formats sharing one disk must not be confusable.
  const { records, discarded } = f.storage.readJournal();
  assert.equal(records.length, 0);
  assert.equal(discarded, strict, 'S1 records do not verify under the phase-2 recipe');
});

test('B6/I7b: mid-journal corruption fails closed rather than silently truncating', async () => {
  // A trailing bad record is an interrupted write; discarding it is right. A bad record
  // with valid records AFTER it is corruption, and folding past it deletes history from
  // the middle of the log while everything downstream still looks consistent. Recovering
  // quietly from that is worse than not recovering, because nobody finds out.
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'a' }, f.grant, { step: 'a' });
  await f.k.invoke(f.exec, 'notes.write', { secret: 'b' }, f.grant, { step: 'b' });
  await f.k.invoke(f.exec, 'notes.write', { secret: 'c' }, f.grant, { step: 'c' });

  // Corrupt a record in the middle by rewriting the raw journal line.
  const raw = (f.storage as unknown as { journal: string[] }).journal;
  const middle = Math.floor(raw.length / 2);
  raw[middle] = raw[middle]!.replace(/"checksum":"[^"]+"/, '"checksum":"corrupted"');

  const read = f.storage.readJournal(verifyS1Record);
  assert.equal(read.corruptionInMiddle, true, 'the break must be reported as non-trailing');

  assert.throws(
    () => S1Kernel.recover(f.storage, [noteTaker()]),
    /non-trailing invalid record/,
    'recovery must refuse rather than fold past a mid-journal break',
  );

  // The operator override is a decision, not a default.
  const { kernel } = S1Kernel.recover(f.storage, [noteTaker()], { quarantine: true });
  assert.ok(kernel.familyIds().length >= 1, 'a deliberate quarantine still recovers the readable records');
});

test('B6/I7c: a TRAILING bad record is still just discarded', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'a' }, f.grant, { step: 'a' });
  const raw = (f.storage as unknown as { journal: string[] }).journal;
  raw[raw.length - 1] = raw[raw.length - 1]!.replace(/"checksum":"[^"]+"/, '"checksum":"torn"');

  const read = f.storage.readJournal(verifyS1Record);
  assert.equal(read.discarded, 1);
  assert.equal(read.corruptionInMiddle, false, 'an interrupted final write is not corruption');
  const { kernel } = S1Kernel.recover(f.storage, [noteTaker()]);
  assert.ok(kernel.familyIds().length >= 1, 'recovery proceeds normally');
});

// ---------------------------------------------------------------------------
// I8–I9 — versioning and forward compatibility
// ---------------------------------------------------------------------------

test('B8/I8: an unknown event kind advances the cursor without changing semantics', async () => {
  // Forward compatibility: a reader from an older revision must not corrupt state or
  // break the chain when it meets a kind it does not understand. It must carry the
  // cursor forward and leave meaning alone.
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'a' }, f.grant, { step: 'a' });
  const events = f.k.events(f.familyId);

  const baseline = digest(foldAll(f.familyId, events));

  const last = events[events.length - 1]!;
  const future: S1Event = {
    ...last,
    id: 'ev_future', seq: last.seq + 1, kind: 'quantum.entangled' as never,
    payload: { note: 'from a later revision' },
    payloadHash: sha(canonical({ note: 'from a later revision' })),
    integrity: { prev: last.integrity.self, self: 'future-self' },
  };

  const withFuture = foldAll(f.familyId, [...events, future]);
  assert.equal(
    withFuture.executions.get(f.exec)!.seq, last.seq + 1,
    'the cursor must advance past a kind we do not understand',
  );

  // Nothing else may have moved.
  const stripped = { ...withFuture };
  const before = foldAll(f.familyId, events);
  assert.equal(stripped.claims.size, before.claims.size);
  assert.equal(stripped.landed.length, before.landed.length);
  assert.equal(stripped.grants.size, before.grants.size);
  assert.notEqual(digest(withFuture), baseline, 'the cursor did move, so the digest must differ');
});

test('B8/I10: golden corpus — a fixed journal folds to a fixed shape', async () => {
  // A conformance anchor. The fold's OUTPUT for a known input is pinned here, so an
  // accidental change to record semantics shows up as a failing test rather than as a
  // silently different interpretation of journals already on disk.
  //
  // Deliberately pinned as a structural summary rather than a hash of the whole
  // projection: a hash would break on every cosmetic field addition and would be
  // retrofitted rather than examined. These are the facts a reader must still derive.
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'one' }, f.grant, { step: 'a' });
  await f.k.invoke(f.exec, 'notes.write', { secret: 'two' }, f.grant, { step: 'b' });

  const fam = foldAll(f.familyId, f.k.events(f.familyId));
  const exec = fam.executions.get(f.exec)!;

  assert.equal(fam.executions.size, 1);
  assert.equal(exec.invocations.size, 2, 'two invocations');
  assert.equal(exec.cell.get('note'), 'two', 'last write wins in the cell');
  assert.equal(fam.landed.length, 0, 'a local capability lands nothing external');
  assert.equal(fam.grants.size, 1);
  assert.equal(fam.grants.get(f.grant.id)!.settled['invocations'], 2, 'two invocations settled');
  assert.equal(fam.grants.get(f.grant.id)!.reserved['invocations'], 0, 'nothing still reserved');
  assert.equal(fam.claims.size, 0, 'non-exclusive claims are released once settled');
  assert.equal(fam.outcomes.size, 2, 'both terminal outcomes are recorded for dedup');

  // Sequence density is part of the format, not an accident of this run.
  const seqs = f.k.events(f.familyId).filter((e) => e.executionId === f.exec).map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq is dense and 1-based per execution');
});

test('B8/I9: the protocol version is stamped on every event and is the format\'s identity', async () => {
  const f = setup();
  await f.k.invoke(f.exec, 'notes.write', { secret: 'a' }, f.grant, { step: 'a' });

  const versions = new Set(f.k.events(f.familyId).map((e) => e.protocolVersion));
  assert.deepEqual([...versions], [S1_PROTOCOL_VERSION], 'one revision writes one version');
  assert.equal(S1_PROTOCOL_VERSION, '2026-08-17');

  // The version is inside the hash preimage, so it cannot be rewritten after the fact to
  // make records from one revision pass as another.
  const ev = f.k.events(f.familyId)[0]!;
  const relabelled = { ...ev, protocolVersion: '1999-01-01' };
  assert.notEqual(selfHashOf(relabelled), relabelled.integrity.self);
});
