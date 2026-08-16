/**
 * Crash matrix (docs/19-CRASH-RECOVERY-MODEL.md).
 *
 * Crashes are injected at every durable write point. After each restart we assert:
 * journal validity, state correctness, invocation lifecycle sanity, side-effect
 * handling, and that no uncommitted candidate became committed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel.ts';
import { Storage, CrashError } from '../src/storage.ts';
import { assertInvariants } from '../src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability, calculator, mcpServer } from '../src/capabilities.ts';
import type { ExecutionId, InvocationId } from '../src/types.ts';

function freshKernel(storage = new Storage()): { k: Kernel; storage: Storage; pay: PaymentCapability } {
  const k = new Kernel(storage);
  const pay = new PaymentCapability();
  for (const c of ALL_CAPABILITIES) k.register(c);
  k.register(pay);
  return { k, storage, pay };
}

test('crash matrix: crash at every durable write point leaves a recoverable, valid journal', async () => {
  // First, run the workload cleanly to learn how many durable writes it performs.
  const probe = freshKernel();
  const execId = probe.k.createExecution();
  const grant = probe.k.issueGrant(execId, { rights: ['compute', 'write'], limits: { invocations: 20, spawnDepth: 2, tokens: 10_000 } });
  await probe.k.invoke(execId, 'tool.calc', { a: 1, b: 2 }, grant, { step: 's1' });
  await probe.k.invoke(execId, 'mcp.files', { path: 'a.txt', content: 'hello' }, grant, { step: 's2' });
  probe.k.checkpoint(execId);
  await probe.k.invoke(execId, 'llm.mock', { ask: 'why' }, grant, { step: 's3' });
  const totalWrites = probe.storage.writes;
  assert.ok(totalWrites > 5, 'workload should perform several durable writes');

  let recoveries = 0;
  for (let crashPoint = 1; crashPoint <= totalWrites; crashPoint += 1) {
    for (const torn of [false, true]) {
      const storage = new Storage();
      const { k } = freshKernel(storage);
      storage.armCrash(crashPoint, { torn, label: `write#${crashPoint}` });

      let crashed = false;
      try {
        const e = k.createExecution();
        const g = k.issueGrant(e, { rights: ['compute', 'write'], limits: { invocations: 20, spawnDepth: 2, tokens: 10_000 } });
        await k.invoke(e, 'tool.calc', { a: 1, b: 2 }, g, { step: 's1' });
        await k.invoke(e, 'mcp.files', { path: 'a.txt', content: 'hello' }, g, { step: 's2' });
        k.checkpoint(e);
        await k.invoke(e, 'llm.mock', { ask: 'why' }, g, { step: 's3' });
      } catch (err) {
        assert.ok(err instanceof CrashError, `expected CrashError, got ${String(err)}`);
        crashed = true;
      }
      assert.ok(crashed, `crash point ${crashPoint} should have fired`);

      // Restart: a brand-new kernel reads only what is durable.
      storage.disarm();
      const recovered = Kernel.recover(storage, ALL_CAPABILITIES);
      recoveries += 1;
      assertInvariants({ kernel: recovered.kernel, storage }, `recovery after crash#${crashPoint} torn=${torn}`);

      // A torn trailing record must be discarded, never partially applied.
      if (torn) {
        assert.ok(recovered.discarded <= 1, 'at most the trailing record may be torn');
      }
      // No staged candidate can survive a crash.
      assert.equal(recovered.kernel.stagedCount(), 0, 'staging must not survive recovery (I16)');
    }
  }
  assert.ok(recoveries >= totalWrites * 2);
});

test('crash after an irreversible external effect lands but before commit ⇒ uncertain, never auto-retried', async () => {
  const storage = new Storage();
  const { k, pay } = freshKernel(storage);
  const execId = k.createExecution();
  const grant = k.issueGrant(execId, { rights: ['pay'], limits: { invocations: 10, spawnDepth: 1 } });

  // The capability performs the external effect, then the process dies.
  pay.crashAfterLanding = true;
  await assert.rejects(
    () => k.invoke(execId, 'payment.charge', { amount: 100 }, grant, { step: 'charge-1' }),
    (err: unknown) => err instanceof CrashError,
  );
  assert.equal(pay.world.size, 1, 'the world saw the charge');

  // Restart. The kernel must NOT conclude success or failure.
  const rec = Kernel.recover(storage, [...ALL_CAPABILITIES, pay]);
  assertInvariants({ kernel: rec.kernel, storage }, 'recovery after landed-but-unrecorded effect');
  assert.equal(rec.uncertain.length, 1, 'exactly one invocation must be uncertain');

  const invId = rec.uncertain[0]!;
  const st = rec.kernel.state(execId as ExecutionId);
  assert.equal(st.invocations.get(invId)!.state, 'uncertain');

  // Crucially: no automatic retry happened — the world still saw exactly one charge.
  assert.equal(pay.world.size, 1, 'recovery must not re-execute an irreversible effect (I13)');

  // Resolution is explicit. Probing the world resolves it to completed.
  pay.crashAfterLanding = false;
  const resolved = await rec.kernel.resolveUncertainty(execId as ExecutionId, invId, { kind: 'probe' });
  assert.equal(resolved, 'completed');
  assertInvariants({ kernel: rec.kernel, storage }, 'after uncertainty resolution');

  const events = rec.kernel.events(execId as ExecutionId);
  assert.ok(events.some((e) => e.kind === 'invocation.uncertain'), 'uncertainty must be journaled');
  assert.ok(events.some((e) => e.kind === 'invocation.uncertainty.resolved'), 'resolution must be journaled');
});

test('an unknown probe answer keeps the invocation uncertain rather than guessing', async () => {
  const storage = new Storage();
  const { k, pay } = freshKernel(storage);
  const execId = k.createExecution();
  const grant = k.issueGrant(execId, { rights: ['pay'], limits: { invocations: 5, spawnDepth: 1 } });
  pay.crashAfterLanding = true;
  await assert.rejects(() => k.invoke(execId, 'payment.charge', { amount: 5 }, grant, { step: 'c' }), (e: unknown) => e instanceof CrashError);

  const rec = Kernel.recover(storage, [...ALL_CAPABILITIES, pay]);
  const invId = rec.uncertain[0]!;
  pay.probeAnswer = 'unknown';
  const resolved = await rec.kernel.resolveUncertainty(execId as ExecutionId, invId, { kind: 'probe' });
  assert.equal(resolved, 'uncertain', 'an unknown answer must not collapse into a guess (I15)');
  assertInvariants({ kernel: rec.kernel, storage }, 'after unknown probe');
});

test('compensation is available for an uncertain effect and is journaled', async () => {
  const storage = new Storage();
  const { k, pay } = freshKernel(storage);
  const execId = k.createExecution();
  const grant = k.issueGrant(execId, { rights: ['pay'], limits: { invocations: 5, spawnDepth: 1 } });
  pay.crashAfterLanding = true;
  await assert.rejects(() => k.invoke(execId, 'payment.charge', { amount: 7 }, grant, { step: 'c' }), (e: unknown) => e instanceof CrashError);

  const rec = Kernel.recover(storage, [...ALL_CAPABILITIES, pay]);
  const invId = rec.uncertain[0]! as InvocationId;
  const resolved = await rec.kernel.resolveUncertainty(execId as ExecutionId, invId, { kind: 'compensate' });
  assert.equal(resolved, 'failed');
  assert.equal(pay.world.size, 0, 'compensation reversed the world effect');
  assertInvariants({ kernel: rec.kernel, storage }, 'after compensation');
});

test('idempotent external effects are safely re-leasable after a crash (no uncertainty)', async () => {
  const storage = new Storage();
  const { k } = freshKernel(storage);
  const execId = k.createExecution();
  const grant = k.issueGrant(execId, { rights: ['remote'], limits: { invocations: 5, spawnDepth: 1 } });
  // Crash during the commit of the outcome (after dispatch was durable).
  const before = storage.writes;
  storage.armCrash(before + 3, { label: 'outcome-commit' });
  await assert.rejects(() => k.invoke(execId, 'remote.a2a', { task: 'x' }, grant, { step: 'r' }), (e: unknown) => e instanceof CrashError);

  storage.disarm();
  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  assert.equal(rec.uncertain.length, 0, 'declared-idempotent effects need no uncertainty state');
  assertInvariants({ kernel: rec.kernel, storage }, 'recovery of idempotent external effect');
});

test('checkpoint written but crash immediately after ⇒ checkpoint is consistent with committed history', async () => {
  const storage = new Storage();
  const { k } = freshKernel(storage);
  const execId = k.createExecution();
  const grant = k.issueGrant(execId, { rights: ['write'], limits: { invocations: 10, spawnDepth: 1 } });
  await k.invoke(execId, 'mcp.files', { path: 'x', content: '1' }, grant, { step: 'w1' });
  const cp = k.checkpoint(execId);
  await k.invoke(execId, 'mcp.files', { path: 'y', content: '2' }, grant, { step: 'w2' });

  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  const check = rec.kernel.resumeFromCheckpoint(cp.id);
  assert.equal(check.consistent, true, 'snapshot fold must equal journal fold at the cut (I20)');
  assertInvariants({ kernel: rec.kernel, storage }, 'resume from checkpoint');
});
