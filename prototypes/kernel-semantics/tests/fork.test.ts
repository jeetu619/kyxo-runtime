/**
 * Fork semantics (docs/17 §8) — the adversarial review's FATAL-1.
 *
 * The resolution under test: resume CONTINUES a lineage (snapshot + committed suffix);
 * fork BRANCHES a lineage (state at the cut ONLY). Effect identity is lineage-scoped,
 * so a fork can never see, or silently redo, what the parent did after the cut.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, ForkError } from '../src/kernel.ts';
import { Storage, CrashError } from '../src/storage.ts';
import { assertInvariants, snapshotByExecution } from '../src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability } from '../src/capabilities.ts';
import type { ExecutionId } from '../src/types.ts';

function setup() {
  const storage = new Storage();
  const k = new Kernel(storage);
  const pay = new PaymentCapability();
  for (const c of ALL_CAPABILITIES) k.register(c);
  k.register(pay);
  return { k, storage, pay };
}

test('fork inherits state at the cut and never the parent suffix; parent is untouched', async () => {
  const { k, storage } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['write', 'compute'], limits: { invocations: 30, spawnDepth: 2 } });

  await k.invoke(a, 'mcp.files', { path: 'shared.txt', content: 'before-cut' }, grant, { step: 'w1' });
  const cp = k.checkpoint(a);

  // Parent continues past the cut.
  await k.invoke(a, 'mcp.files', { path: 'after.txt', content: 'after-cut' }, grant, { step: 'w2' });
  await k.invoke(a, 'tool.calc', { a: 9, b: 9 }, grant, { step: 'calc-after-cut' });

  const parentBefore = snapshotByExecution(storage).get(a)!.map((e) => e.id);

  const b = k.fork(cp.id, { dispositions: {} });
  assertInvariants({ kernel: k, storage }, 'after fork');

  // Parent history is byte-identical.
  const parentAfter = snapshotByExecution(storage).get(a)!.map((e) => e.id);
  assert.deepEqual(parentAfter, parentBefore, 'fork must not mutate parent history (I11)');

  // Child sees exactly the cut state.
  const childState = k.state(b);
  assert.equal(childState.cell.get('file:shared.txt'), 'before-cut', 'child sees pre-cut state');
  assert.equal(childState.cell.get('file:after.txt'), undefined, 'child must NOT inherit post-cut parent effects');

  // Child declares explicit ancestry.
  const forkEvent = k.events(b)[0]!;
  assert.equal(forkEvent.kind, 'execution.forked');
  assert.equal(forkEvent.payload['parentExecution'], a);
  assert.equal(forkEvent.payload['cutSeq'], cp.cutSeq);

  // The parent's post-cut effect key is NOT in the child's effect index: the child may
  // legitimately perform that same work itself.
  const out = await k.invoke(b, 'tool.calc', { a: 9, b: 9 }, grant, { step: 'calc-after-cut' });
  assert.equal(out.deduplicated, undefined, 'post-cut parent work must not dedup in the child lineage');
  assert.equal(out.state, 'completed');
  assertInvariants({ kernel: k, storage }, 'child diverges');
});

test('a fork may not silently redo a protected irreversible effect', async () => {
  const { k, storage, pay } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['pay'], limits: { invocations: 20, spawnDepth: 1 } });

  await k.invoke(a, 'payment.charge', { amount: 250 }, grant, { step: 'charge' });
  assert.equal(pay.world.size, 1);
  const cp = k.checkpoint(a);

  const b = k.fork(cp.id, { dispositions: {} });
  // Replaying the identical charge in the fork must be refused structurally.
  await assert.rejects(
    () => k.invoke(b, 'payment.charge', { amount: 250 }, grant, { step: 'charge' }),
    (e: unknown) => e instanceof ForkError,
    'fork must refuse to replay a protected irreversible effect',
  );
  assert.equal(pay.world.size, 1, 'the world saw exactly one charge');
  assertInvariants({ kernel: k, storage }, 'after refused replay');

  // The refusal is auditable.
  const denied = k.events(b).filter((e) => e.kind === 'policy.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.payload['reason'], 'protected-irreversible-replay');
});

test('an explicit, journaled override can replay a protected effect (and only then)', async () => {
  const { k, storage, pay } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['pay'], limits: { invocations: 20, spawnDepth: 1 } });
  await k.invoke(a, 'payment.charge', { amount: 10 }, grant, { step: 'charge' });
  const cp = k.checkpoint(a);
  const key = [...k.state(a).protectedEffects][0]!;

  const b = k.fork(cp.id, {
    dispositions: {},
    allowReplayOfProtected: { keys: [key], reason: 'operator: original charge was voided out-of-band' },
  });
  const out = await k.invoke(b, 'payment.charge', { amount: 10 }, grant, { step: 'charge' });
  assert.equal(out.state, 'completed');
  const forkEvent = k.events(b)[0]!;
  assert.ok(forkEvent.payload['replayOverride'], 'the override must be journaled with its reason');
  assertInvariants({ kernel: k, storage }, 'after explicit override');
});

test('forking with an in-flight pending invocation requires an explicit disposition', async () => {
  const { k, storage, pay } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['pay'], limits: { invocations: 20, spawnDepth: 1 } });

  pay.crashAfterLanding = true;
  await assert.rejects(() => k.invoke(a, 'payment.charge', { amount: 99 }, grant, { step: 'c' }), (e: unknown) => e instanceof CrashError);
  const rec = Kernel.recover(storage, [...ALL_CAPABILITIES, pay]);
  const k2 = rec.kernel;
  const cp = k2.checkpoint(a as ExecutionId);
  assert.equal(cp.pending.length, 1, 'the uncertain invocation is pending at the cut');

  // No disposition ⇒ fork refuses. Silence about an unknown external outcome is the bug.
  assert.throws(() => k2.fork(cp.id, { dispositions: {} }), (e: unknown) => e instanceof ForkError);

  // re-lease of an irreversible unknown ⇒ refused (could double-charge).
  assert.throws(
    () => k2.fork(cp.id, { dispositions: { [cp.pending[0]!.id]: 're-lease' } }),
    (e: unknown) => e instanceof ForkError,
  );

  // adopt ⇒ allowed, and the effect becomes protected in the child.
  const b = k2.fork(cp.id, { dispositions: { [cp.pending[0]!.id]: 'adopt' } });
  assert.ok(k2.state(b).protectedEffects.has(cp.pending[0]!.effectKey));
  assertInvariants({ kernel: k2, storage }, 'fork with adopt disposition');
});

test('irreversible-effect protection survives a process restart (regression: docs/20 F-6)', async () => {
  const { k, storage, pay } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['pay'], limits: { invocations: 20, spawnDepth: 1 } });
  await k.invoke(a, 'payment.charge', { amount: 500 }, grant, { step: 'charge' });
  assert.equal(k.state(a).protectedEffects.size, 1, 'protected while live');

  // Restart. Protection must be rebuilt from committed evidence, not lost with memory.
  const rec = Kernel.recover(storage, [...ALL_CAPABILITIES, pay]);
  assert.equal(rec.kernel.state(a as ExecutionId).protectedEffects.size, 1, 'protection must survive recovery');

  const cp = rec.kernel.checkpoint(a as ExecutionId);
  assert.equal(cp.protectedEffects.length, 1, 'and must be carried into checkpoints taken after recovery');

  const b = rec.kernel.fork(cp.id, { dispositions: {} });
  const gb = rec.kernel.issueGrant(b, { rights: ['pay'], limits: { invocations: 20, spawnDepth: 1 } });
  await assert.rejects(
    () => rec.kernel.invoke(b, 'payment.charge', { amount: 500 }, gb, { step: 'charge' }),
    (e: unknown) => e instanceof ForkError,
    'a fork taken after a restart must still refuse to replay the charge',
  );
  assert.equal(pay.world.size, 1, 'the world saw exactly one charge');
  assertInvariants({ kernel: rec.kernel, storage }, 'post-restart fork protection');
});

test('multiple forks from one checkpoint are independent; forks nest', async () => {
  const { k, storage } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['write'], limits: { invocations: 40, spawnDepth: 1 } });
  await k.invoke(a, 'mcp.files', { path: 'base', content: 'v0' }, grant, { step: 'base' });
  const cp = k.checkpoint(a);

  const b1 = k.fork(cp.id, { dispositions: {} });
  const b2 = k.fork(cp.id, { dispositions: {} });
  await k.invoke(b1, 'mcp.files', { path: 'branch', content: 'b1' }, grant, { step: 'branch' });
  await k.invoke(b2, 'mcp.files', { path: 'branch', content: 'b2' }, grant, { step: 'branch' });

  assert.equal(k.state(b1).cell.get('file:branch'), 'b1');
  assert.equal(k.state(b2).cell.get('file:branch'), 'b2', 'sibling forks must not interfere');
  assert.equal(k.state(a).cell.get('file:branch'), undefined, 'parent unaffected by either fork');

  // Nested fork.
  const cp2 = k.checkpoint(b1);
  const c1 = k.fork(cp2.id, { dispositions: {} });
  assert.equal(k.state(c1).cell.get('file:branch'), 'b1', 'nested fork inherits its own parent cut');
  assert.equal(k.events(c1)[0]!.payload['parentExecution'], b1);
  assertInvariants({ kernel: k, storage }, 'nested forks');
});

test('crash during fork creation leaves no half-born lineage', async () => {
  const { k, storage } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['write'], limits: { invocations: 10, spawnDepth: 1 } });
  await k.invoke(a, 'mcp.files', { path: 'p', content: 'v' }, grant, { step: 's' });
  const cp = k.checkpoint(a);

  storage.armCrash(storage.writes + 1, { label: 'fork-commit' });
  assert.throws(() => k.fork(cp.id, { dispositions: {} }), (e: unknown) => e instanceof CrashError);

  storage.disarm();
  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  assertInvariants({ kernel: rec.kernel, storage }, 'recovery after fork crash');
  // Either the fork event committed or it did not; there is no third state.
  const forks = rec.kernel.executionIds().filter((id) => {
    const evs = rec.kernel.events(id);
    return evs[0]?.kind === 'execution.forked';
  });
  assert.equal(forks.length, 0, 'a crashed fork must leave no lineage at all');
});

test('resume continues the lineage; fork branches it — they are different verbs', async () => {
  const { k, storage } = setup();
  const a = k.createExecution();
  const grant = k.issueGrant(a, { rights: ['write'], limits: { invocations: 20, spawnDepth: 1 } });
  await k.invoke(a, 'mcp.files', { path: 'f', content: '1' }, grant, { step: 'one' });
  const cp = k.checkpoint(a);
  await k.invoke(a, 'mcp.files', { path: 'g', content: '2' }, grant, { step: 'two' });

  // Resume: same execution identity, sees the suffix.
  const resumed = k.resumeFromCheckpoint(cp.id);
  assert.equal(resumed.executionId, a, 'resume keeps execution identity');
  assert.equal(k.state(a).cell.get('file:g'), '2', 'resumed lineage retains post-cut history');

  // Fork: new identity, does not see the suffix.
  const b = k.fork(cp.id, { dispositions: {} });
  assert.notEqual(b, a);
  assert.equal(k.state(b).cell.get('file:g'), undefined, 'fork does not inherit the suffix');
  assertInvariants({ kernel: k, storage }, 'resume vs fork');
});
