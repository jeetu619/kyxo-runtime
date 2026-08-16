/**
 * Deduplication (docs/17 §9).
 *
 * Six mechanisms are deliberately kept distinct. The phase-1 bug this suite exists to
 * prevent: content-addressed storage dedup silently suppressing a journal record, so
 * the audit trail lost the fact that an invocation produced an artifact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel.ts';
import { Storage } from '../src/storage.ts';
import { assertInvariants } from '../src/invariants.ts';
import { ALL_CAPABILITIES } from '../src/capabilities.ts';

function setup() {
  const storage = new Storage();
  const k = new Kernel(storage);
  for (const c of ALL_CAPABILITIES) k.register(c);
  return { k, storage };
}

test('CAS dedup never suppresses a journal record: identical content, two provenances', async () => {
  const { k, storage } = setup();
  const a = k.createExecution();
  const b = k.createExecution();
  const ga = k.issueGrant(a, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 1 } });
  const gb = k.issueGrant(b, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 1 } });

  // Byte-identical outputs from two different executions.
  await k.invoke(a, 'tool.calc', { a: 2, b: 2 }, ga, { step: 'calc' });
  await k.invoke(b, 'tool.calc', { a: 2, b: 2 }, gb, { step: 'calc' });

  const artifactsA = k.events(a).filter((e) => e.kind === 'artifact.produced');
  const artifactsB = k.events(b).filter((e) => e.kind === 'artifact.produced');
  assert.equal(artifactsA.length, 1, 'execution A journaled its production');
  assert.equal(artifactsB.length, 1, 'execution B journaled its production even though bytes deduped');
  assert.equal(artifactsA[0]!.payload['ref'], artifactsB[0]!.payload['ref'], 'CAS dedups the bytes');
  assert.notEqual(
    artifactsA[0]!.payload['producedBy'],
    artifactsB[0]!.payload['producedBy'],
    'provenance is per-producer, never first-writer-wins (I14)',
  );
  assertInvariants({ kernel: k, storage }, 'cross-execution CAS dedup');
});

test('duplicate delivery suppresses the effect but leaves audit evidence', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['write'], limits: { invocations: 10, spawnDepth: 1 } });

  const first = await k.invoke(e, 'mcp.files', { path: 'f', content: 'v1' }, g, { step: 'w' });
  const dup = await k.invoke(e, 'mcp.files', { path: 'f', content: 'v1' }, g, { step: 'w', duplicateDelivery: true });

  assert.equal(dup.deduplicated, true);
  assert.equal(dup.invocationId, first.invocationId, 'the duplicate maps to the original invocation');

  const evidence = k.events(e).filter((x) => x.kind === 'delivery.duplicate');
  assert.equal(evidence.length, 1, 'the duplicate delivery itself is journaled (I14)');
  assert.equal(evidence[0]!.payload['originalInvocation'], first.invocationId);

  // The effect ran exactly once.
  const writes = k.events(e).filter((x) => x.kind === 'state.updated');
  assert.equal(writes.length, 1, 'the effect must not double-apply');
  assertInvariants({ kernel: k, storage }, 'duplicate delivery');
});

test('effect identity is content-inclusive: same step, different arguments ⇒ different effect', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 1 } });

  const r1 = await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, g, { step: 'same-step' });
  const r2 = await k.invoke(e, 'tool.calc', { a: 5, b: 5 }, g, { step: 'same-step' });

  assert.equal(r1.deduplicated, undefined);
  assert.equal(r2.deduplicated, undefined, 'different arguments must not collide on step position alone');
  assert.notEqual(r1.invocationId, r2.invocationId);
  assert.equal(r2.output, 10);
  assertInvariants({ kernel: k, storage }, 'content-inclusive keys');
});

test('repeated identical requests within a lineage deduplicate and are journaled', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 1 } });

  await k.invoke(e, 'tool.calc', { a: 3, b: 3 }, g, { step: 'x' });
  await k.invoke(e, 'tool.calc', { a: 3, b: 3 }, g, { step: 'x' });
  await k.invoke(e, 'tool.calc', { a: 3, b: 3 }, g, { step: 'x' });

  const deduped = k.events(e).filter((x) => x.kind === 'effect.deduplicated');
  assert.equal(deduped.length, 2, 'each suppressed attempt leaves its own record');
  const completions = k.events(e).filter((x) => x.kind === 'invocation.completed');
  assert.equal(completions.length, 1, 'the effect executed once');
  assertInvariants({ kernel: k, storage }, 'lineage-local dedup');
});

test('deduplicated attempts do not consume budget twice', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 3, spawnDepth: 1 } });

  await k.invoke(e, 'tool.calc', { a: 1, b: 2 }, g, { step: 's' });
  for (let i = 0; i < 5; i += 1) {
    await k.invoke(e, 'tool.calc', { a: 1, b: 2 }, g, { step: 's' });
  }
  const grant = [...k.state(e).grants.values()][0]!;
  assert.equal(grant.settled['invocations'], 1, 'only the executed effect settles budget');
  assertInvariants({ kernel: k, storage }, 'dedup and budget');
});
