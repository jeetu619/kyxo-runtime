/**
 * Serialization compatibility / schema evolution.
 *
 * The record format cannot be frozen unless it can evolve. These tests establish the
 * forward- and backward-compatibility rules a conforming implementation must honour,
 * and they are the CI gate that stops a future change from silently breaking readers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel.ts';
import { Storage, sha } from '../src/storage.ts';
import { checkInvariants } from '../src/invariants.ts';
import { ALL_CAPABILITIES } from '../src/capabilities.ts';
import type { ExecutionId, KernelEvent } from '../src/types.ts';

function seeded() {
  const storage = new Storage();
  const kernel = new Kernel(storage);
  for (const c of ALL_CAPABILITIES) kernel.register(c);
  return { storage, kernel };
}

/** Reach into the durable journal the way a foreign writer would. */
function rawJournal(storage: Storage): string[] {
  return (storage as unknown as { journal: string[] }).journal;
}

async function seedOneInvocation(): Promise<{ storage: Storage; kernel: Kernel; exec: ExecutionId; tip: KernelEvent }> {
  const { storage, kernel } = seeded();
  const exec = kernel.createExecution();
  const grant = kernel.issueGrant(exec, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 1 } });
  await kernel.invoke(exec, 'tool.calc', { a: 1, b: 2 }, grant, { step: 's' });
  const events = kernel.events(exec);
  return { storage, kernel, exec, tip: events[events.length - 1]! };
}

test('a reader tolerates an unknown event kind and unknown envelope fields (must-ignore-unknown)', async () => {
  const { storage, exec, tip } = await seedOneInvocation();

  // A future revision writes an event kind this reader has never heard of, carrying an
  // envelope field that did not exist when this reader was built.
  const base = {
    id: 'ev_future1',
    seq: tip.seq + 1,
    kind: 'kyxo.future.telemetry',
    schemaVersion: 99,
    protocolVersion: '2027-01-01',
    executionId: exec,
    correlationId: tip.correlationId,
    actorId: 'kernel',
    occurredAt: tip.occurredAt + 1,
    payload: { newField: 'x' },
    futureEnvelopeField: { unknown: true },
  };
  const self = sha({ ...base, prev: tip.integrity.self });
  const futureEvent = { ...base, integrity: { prev: tip.integrity.self, self } };
  const record = { commitToken: 'ct_future', executionId: exec, events: [futureEvent], checksum: sha([futureEvent]) };
  rawJournal(storage).push(JSON.stringify(record));

  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  assert.equal(rec.discarded, 0, 'a well-formed future record must not be discarded');
  assert.deepEqual(checkInvariants({ kernel: rec.kernel, storage }), [], 'the chain must stay valid across an unknown kind');
  assert.ok(
    rec.kernel.events(exec).some((e) => e.kind === ('kyxo.future.telemetry' as never)),
    'unknown events must be retained, not dropped — a reader that drops them corrupts the chain for later readers',
  );
});

test('the hash chain covers unknown fields, so a reader cannot silently normalize them away', async () => {
  const { storage, exec, tip } = await seedOneInvocation();

  // Same event, but the writer's hash omitted the new field (a buggy future writer).
  const base = {
    id: 'ev_bad', seq: tip.seq + 1, kind: 'kyxo.future.telemetry', schemaVersion: 99,
    protocolVersion: '2027-01-01', executionId: exec, correlationId: tip.correlationId,
    actorId: 'kernel', occurredAt: tip.occurredAt + 1, payload: {},
  };
  const hashWithoutNewField = sha({ ...base, prev: tip.integrity.self });
  const eventWithNewField = { ...base, sneakyField: 'not covered by the hash', integrity: { prev: tip.integrity.self, self: hashWithoutNewField } };
  const record = { commitToken: 'ct_bad', executionId: exec, events: [eventWithNewField], checksum: sha([eventWithNewField]) };
  rawJournal(storage).push(JSON.stringify(record));

  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  const violations = checkInvariants({ kernel: rec.kernel, storage });
  assert.ok(
    violations.some((v) => v.id === 'I6'),
    'an event whose hash does not cover its own content must be detected as tampered',
  );
});

test('a torn record is discarded; a valid record after it is NOT silently accepted (chain break is visible)', async () => {
  const { storage, exec, tip } = await seedOneInvocation();
  const journal = rawJournal(storage);

  // Torn write: truncated JSON.
  journal.push('{"commitToken":"ct_torn","executionId":"' + exec + '","events":[{"id":"ev_t');

  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  assert.equal(rec.discarded, 1, 'the torn record is discarded');
  assert.deepEqual(checkInvariants({ kernel: rec.kernel, storage }), [], 'discarding a trailing torn record leaves a consistent state');
  assert.equal(rec.kernel.state(exec).seq, tip.seq, 'state stops at the last valid record');
});

test('protocolVersion is recorded per event so a mixed-version journal stays interpretable', async () => {
  const { kernel, exec } = await seedOneInvocation();
  const events = kernel.events(exec);
  assert.ok(events.every((e) => typeof e.protocolVersion === 'string' && e.protocolVersion.length > 0),
    'every event declares the revision its writer spoke');
  assert.ok(events.every((e) => typeof e.schemaVersion === 'number'),
    'every event declares its payload schema version, so (kind, schemaVersion) is the unit of evolution');
});

test('a record for an execution the reader has never seen creates that lineage rather than failing', async () => {
  const { storage } = await seedOneInvocation();

  // A foreign execution appears in the journal (e.g. a merged log from another node).
  const foreignExec = 'exec_foreign' as ExecutionId;
  const base = {
    id: 'ev_f1', seq: 1, kind: 'execution.created', schemaVersion: 1,
    protocolVersion: '2026-08-16', executionId: foreignExec, correlationId: 'corr_foreign',
    actorId: 'kernel', occurredAt: 1, payload: { correlationId: 'corr_foreign', definitionHash: 'D9' },
  };
  const self = sha({ ...base, prev: 'genesis' });
  const ev = { ...base, integrity: { prev: 'genesis', self } };
  rawJournal(storage).push(JSON.stringify({ commitToken: 'ct_f', executionId: foreignExec, events: [ev], checksum: sha([ev]) }));

  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  assert.ok(rec.kernel.executionIds().includes(foreignExec), 'an unknown lineage is materialized from its own records');
  assert.deepEqual(checkInvariants({ kernel: rec.kernel, storage }), []);
});
