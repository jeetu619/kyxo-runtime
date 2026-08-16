/**
 * The S1 fork matrix.
 *
 * Fork branches a lineage: the child starts from the parent's state at a cut and diverges.
 * Resume continues a lineage; fork creates a new one. They are distinct verbs and the
 * matrix exercises the ways a child can be created relative to what the parent was doing.
 *
 * The dimensions crossed here are:
 *   WHERE the cut falls — before a landing, after it, at the tip
 *   WHAT the parent was doing — idle, suspended, uncertain, settled
 *   HOW DEEP the lineage goes — child, grandchild, siblings
 *
 * The invariant across all of them: a child inherits STATE and AUTHORITY-SPENT, and is
 * bound by every exclusive effect the family has landed. It never inherits the right to
 * repeat one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError, ForkError, BudgetError } from '../src/s1-kernel.ts';
import { assertS1Invariants } from '../src/s1-invariants.ts';
import { digest, foldAll } from '../src/s1-fold.ts';
import type { FamilyId } from '../src/s1-types.ts';
import { resolveEffectIdentity } from '../src/s1b-identity.ts';
import { Storage, CrashError, sha } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectKey,
  EffectProposal, InvokeCtx,
} from '../src/types.ts';

class World {
  readonly calls: string[] = [];
  apply(d: string): void { this.calls.push(d); }
  count(d: string): number { return this.calls.filter((c) => c === d).length; }
}

function payer(world: World): CapabilityProvider {
  return {
    manifest: {
      id: 'pay.card', version: '1.0.0',
      traits: {
        effectClass: 'external-irreversible', probeable: true, compensatable: true,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'payments.charge', fields: ['id'] },
      units: { usd: { perInvocation: 1, metered: true } },
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as { suspend?: boolean };
      if (ctx.resume === undefined) {
        world.apply('charge');
        yield { type: 'external', descriptor: 'charge', landed: true };
      }
      if (req.suspend === true && ctx.resume === undefined) {
        return { status: 'suspend', reason: 'approval', payload: { ref: 'a1' } };
      }
      return { status: 'ok', output: { receipt: 'r1' } };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'landed'; },
    async compensate(): Promise<'compensated' | 'failed'> { return 'compensated'; },
  };
}

function writer(): CapabilityProvider {
  return {
    manifest: {
      id: 'cell.write', version: '1.0.0',
      traits: {
        effectClass: 'local', probeable: false, compensatable: false, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as { key: string; value: unknown };
      yield { type: 'state', key: req.key, value: req.value };
      return { status: 'ok', output: { ok: true } };
    },
  };
}

const LIMITS = { invocations: 40, usd: 100 };

function keyFor(request: unknown, step: string, cap = 'pay.card'): EffectKey {
  return resolveEffectIdentity({
    capabilityId: 'pay.card', effectClass: 'external-irreversible', request,
    schema: { operation: 'payments.charge', fields: ['id'] },
  }).key;
}

function setup(world: World): {
  k: S1Kernel; storage: Storage; exec: ReturnType<S1Kernel['createExecution']>;
  grant: ReturnType<S1Kernel['issueGrant']>; familyId: FamilyId;
} {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(world));
  k.register(writer());
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, { rights: ['pay', 'write'], limits: LIMITS });
  return { k, storage, exec, grant, familyId: k.familyFor(exec).familyId };
}

function check(k: S1Kernel, familyId: FamilyId): void {
  assertS1Invariants(k.family(familyId), { events: k.events(familyId) });
  assert.equal(digest(foldAll(familyId, k.events(familyId))), digest(k.family(familyId)));
}

// ---------------------------------------------------------------------------
// Where the cut falls
// ---------------------------------------------------------------------------

test('fork F1: cut at the tip — the child sees everything the parent had', async () => {
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'cell.write', { key: 'a', value: 1 }, f.grant, { step: 'w1' });
  await f.k.invoke(f.exec, 'cell.write', { key: 'b', value: 2 }, f.grant, { step: 'w2' });

  const tip = f.k.familyFor(f.exec).executions.get(f.exec)!.seq;
  const child = f.k.fork(f.exec, tip);

  const cell = f.k.familyFor(f.exec).executions.get(child)!.cell;
  assert.equal(cell.get('a'), 1);
  assert.equal(cell.get('b'), 2);
  check(f.k, f.familyId);
});

test('fork F2: cut mid-history — the child sees only what existed at the cut', async () => {
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'cell.write', { key: 'a', value: 1 }, f.grant, { step: 'w1' });
  const cut = f.k.familyFor(f.exec).executions.get(f.exec)!.seq;
  await f.k.invoke(f.exec, 'cell.write', { key: 'b', value: 2 }, f.grant, { step: 'w2' });

  const child = f.k.fork(f.exec, cut);
  const cell = f.k.familyFor(f.exec).executions.get(child)!.cell;
  assert.equal(cell.get('a'), 1, 'state before the cut is inherited');
  assert.equal(cell.get('b'), undefined, 'state after the cut is not');
  check(f.k, f.familyId);
});

test('fork F3: a cut past the parent tip is refused', async () => {
  const world = new World();
  const f = setup(world);
  const tip = f.k.familyFor(f.exec).executions.get(f.exec)!.seq;
  assert.throws(() => f.k.fork(f.exec, tip + 5), (e: unknown) => e instanceof ForkError);
});

test('fork F4: the child\'s journal is self-sufficient — no checkpoint blob is consulted', async () => {
  // docs/20 F-8: inherited state is materialised INTO the child's first record, so a
  // reader with nothing but the journal reconstructs the child correctly.
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'cell.write', { key: 'a', value: 'inherited' }, f.grant, { step: 'w1' });
  const child = f.k.fork(f.exec, f.k.familyFor(f.exec).executions.get(f.exec)!.seq);

  const replayed = foldAll(f.familyId, f.k.events(f.familyId));
  assert.equal(
    replayed.executions.get(child)!.cell.get('a'), 'inherited',
    'a fold of the journal alone must reconstruct the child\'s inherited state',
  );
  check(f.k, f.familyId);
});

// ---------------------------------------------------------------------------
// What the parent was doing
// ---------------------------------------------------------------------------

test('fork F5: cut BEFORE a landing — the child is still bound by it', async () => {
  const world = new World();
  const f = setup(world);
  const cut = f.k.familyFor(f.exec).executions.get(f.exec)!.seq;
  await f.k.invoke(f.exec, 'pay.card', { id: 1 }, f.grant, { step: 'charge' });

  const child = f.k.fork(f.exec, cut);
  const cg = f.k.rehydrateGrant(child, f.grant.id);
  await assert.rejects(
    () => f.k.invoke(child, 'pay.card', { id: 1 }, cg, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'B9a: which cut a child came from does not change what the family did to the world',
  );
  assert.equal(world.count('charge'), 1);
  check(f.k, f.familyId);
});

test('fork F6: cut AFTER a landing — same answer, by the same mechanism', async () => {
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'pay.card', { id: 1 }, f.grant, { step: 'charge' });
  const child = f.k.fork(f.exec, f.k.familyFor(f.exec).executions.get(f.exec)!.seq);
  const cg = f.k.rehydrateGrant(child, f.grant.id);

  await assert.rejects(
    () => f.k.invoke(child, 'pay.card', { id: 1 }, cg, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1);
  check(f.k, f.familyId);
});

test('fork F7: forking while the parent holds a suspended invocation', async () => {
  const world = new World();
  const f = setup(world);
  const out = await f.k.invoke(f.exec, 'pay.card', { id: 1, suspend: true }, f.grant, { step: 'charge' });
  assert.equal(out.state, 'suspended');

  const child = f.k.fork(f.exec, f.k.familyFor(f.exec).executions.get(f.exec)!.seq);
  const cg = f.k.rehydrateGrant(child, f.grant.id);

  // The parent's lease is the parent's. The child may not take over the effect key.
  await assert.rejects(
    () => f.k.invoke(child, 'pay.card', { id: 1, suspend: true }, cg, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'a fork must not be a way to seize an effect another execution is holding',
  );

  // And the parent can still finish its own work.
  const resumed = await f.k.resume(f.exec, out.invocationId, { approved: true });
  assert.equal(resumed.state, 'completed');
  assert.equal(world.count('charge'), 1);
  check(f.k, f.familyId);
});

test('fork F8: forking while an invocation is uncertain', async () => {
  const world = new World();
  const storage = new Storage();
  const cap = payer(world);
  const k1 = new S1Kernel(storage);
  k1.register(cap); k1.register(writer());
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, { rights: ['pay', 'write'], limits: LIMITS });

  storage.armCrashWhen((s) => s.includes('"kind":"invocation.completed"'), { label: 'settle' });
  await assert.rejects(
    () => k1.invoke(exec, 'pay.card', { id: 1 }, grant, { step: 'charge' }),
    (e: unknown) => e instanceof CrashError,
  );
  storage.disarm();

  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [cap, writer()]);
  assert.equal(uncertain.length, 1);

  const child = k2.fork(exec, 2);
  const cg = k2.rehydrateGrant(child, grant.id);
  await assert.rejects(
    () => k2.invoke(child, 'pay.card', { id: 1 }, cg, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'forking must not be a way to escape an unresolved uncertainty (I15)',
  );
  assert.equal(world.count('charge'), 1);
  check(k2, k2.familyFor(exec).familyId);
});

// ---------------------------------------------------------------------------
// How deep the lineage goes
// ---------------------------------------------------------------------------

test('fork F9: a grandchild is bound by what its grandparent did', async () => {
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'pay.card', { id: 1 }, f.grant, { step: 'charge' });

  const child = f.k.fork(f.exec, 1);
  const grandchild = f.k.fork(child, 1);
  const gg = f.k.rehydrateGrant(grandchild, f.grant.id);

  await assert.rejects(
    () => f.k.invoke(grandchild, 'pay.card', { id: 1 }, gg, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1);
  check(f.k, f.familyId);
});

test('fork F10: N siblings share one budget and one protected-effect ledger', async () => {
  const world = new World();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(world)); k.register(writer());
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const grant = k.issueGrant(exec, { rights: ['pay', 'write'], limits: { invocations: 6, usd: 100 } });

  const cut = k.familyFor(exec).executions.get(exec)!.seq;
  const siblings = Array.from({ length: 5 }, () => k.fork(exec, cut));
  const grants = siblings.map((s) => k.rehydrateGrant(s, grant.id));

  // Every sibling attempts the same charge. Exactly one may reach the world.
  let charged = 0;
  for (let i = 0; i < siblings.length; i += 1) {
    try {
      await k.invoke(siblings[i]!, 'pay.card', { id: 1 }, grants[i]!, { step: 'charge' });
      charged += 1;
    } catch (e) {
      assert.ok(e instanceof ClaimDeniedError || e instanceof BudgetError);
    }
  }
  assert.equal(charged, 1, 'five divergent branches, one world');
  assert.equal(world.count('charge'), 1);

  // And they drew on one budget, not five.
  assert.equal(k.remainingFor(siblings[0]!, grant.id, 'invocations'), 5);
  check(k, familyId);
});

test('fork F11: a fork cannot outlive a revoked grant', async () => {
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'cell.write', { key: 'a', value: 1 }, f.grant, { step: 'w1' });
  f.k.revoke(f.exec, f.grant);

  const child = f.k.fork(f.exec, f.k.familyFor(f.exec).executions.get(f.exec)!.seq);
  const cg = f.k.rehydrateGrant(child, f.grant.id);
  await assert.rejects(
    () => f.k.invoke(child, 'cell.write', { key: 'b', value: 2 }, cg, { step: 'w2' }),
    (e: unknown) => /revoked/.test(String(e)),
    'forking must not resurrect revoked authority',
  );
  check(f.k, f.familyId);
});

test('fork F12: the whole matrix survives a restart', async () => {
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'cell.write', { key: 'a', value: 1 }, f.grant, { step: 'w1' });
  await f.k.invoke(f.exec, 'pay.card', { id: 1 }, f.grant, { step: 'charge' });
  const child = f.k.fork(f.exec, 2);
  const grandchild = f.k.fork(child, 1);

  const { kernel: k2 } = S1Kernel.recover(f.storage, [payer(world), writer()]);
  check(k2, f.familyId);

  for (const e of [f.exec, child, grandchild]) {
    assert.equal(
      k2.isProtected(e, keyFor({ id: 1 }, 'charge')), true,
      'every execution in the family is bound after a cold start (I25)',
    );
  }
  const cg = k2.rehydrateGrant(grandchild, f.grant.id);
  await assert.rejects(
    () => k2.invoke(grandchild, 'pay.card', { id: 1 }, cg, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1);
});
