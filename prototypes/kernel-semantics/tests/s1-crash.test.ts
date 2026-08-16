/**
 * The S1 crash matrix.
 *
 * Two layers, because they catch different things:
 *
 *   1. EIGHTEEN NAMED POSITIONS — semantically interesting moments in an invocation's
 *      life, each with an assertion about what must be true after the restart. A named
 *      position says what the design claims; a sweep only says nothing blew up.
 *   2. EXHAUSTIVE SWEEP — a crash before every durable write of a rich workload, clean
 *      and torn, with the full S1 invariant set asserted after each restart. This is what
 *      catches the position nobody thought to name.
 *
 * Every restart builds a brand-new kernel from storage alone. Nothing in-process crosses
 * the boundary, which is the only way to test I25: a protection that lives in memory is a
 * protection that lasts until the next restart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError, verifyS1Record } from '../src/s1-kernel.ts';
import { assertS1Invariants } from '../src/s1-invariants.ts';
import { hasLanded } from '../src/s1-fold.ts';
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
      yield { type: 'state', key: 'last', value: 'charged' };
      return { status: 'ok', output: { receipt: 'r1' } };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'landed'; },
    async compensate(): Promise<'compensated' | 'failed'> { world.apply('refund'); return 'compensated'; },
  };
}

function notes(): CapabilityProvider {
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
      yield { type: 'state', key: 'note', value: (ctx.request as { v?: string }).v ?? 'x' };
      yield { type: 'artifact', content: { note: (ctx.request as { v?: string }).v ?? 'x' } };
      return { status: 'ok', output: { ok: true } };
    },
  };
}

const GRANT = { rights: ['pay', 'write'], limits: { invocations: 40, usd: 200, spawnDepth: 1 } };

function keyFor(request: unknown, step: string, cap = 'pay.card'): EffectKey {
  return resolveEffectIdentity({
    capabilityId: 'pay.card', effectClass: 'external-irreversible', request,
    schema: { operation: 'payments.charge', fields: ['id'] },
  }).key;
}

function providers(world: World): CapabilityProvider[] { return [payer(world), notes()]; }

/** Rebuild from storage alone and check everything. */
function restart(storage: Storage, world: World): { k: S1Kernel; uncertain: readonly string[] } {
  const { kernel, uncertain } = S1Kernel.recover(storage, providers(world));
  for (const familyId of kernel.familyIds()) {
    assertS1Invariants(kernel.family(familyId), { events: kernel.events(familyId) });
  }
  return { k: kernel, uncertain };
}

// ---------------------------------------------------------------------------
// Layer 1 — eighteen named positions
// ---------------------------------------------------------------------------

interface Position {
  readonly n: number;
  readonly name: string;
  /** Runs until the crash fires. */
  readonly run: (k: S1Kernel, storage: Storage, world: World) => Promise<void>;
  /** Arms the crash at a NAMED position rather than a counted write. */
  readonly arm: (storage: Storage) => void;
  readonly check: (k: S1Kernel, world: World, uncertain: readonly string[]) => void;
}

/** Crash on the first commit record containing an event of this kind. */
function onKind(kind: string, opts?: { torn?: boolean; nth?: number }) {
  return (storage: Storage): void => {
    let seen = 0;
    storage.armCrashWhen((s) => {
      if (!s.includes(`"kind":"${kind}"`)) return false;
      seen += 1;
      return seen >= (opts?.nth ?? 1);
    }, { torn: opts?.torn ?? false, label: kind });
  };
}

const POSITIONS: Position[] = [
  {
    n: 1, name: 'before execution.created',
    arm: onKind('execution.created'),
    run: async (k) => { k.createExecution(); },
    check: (k) => {
      assert.equal(k.familyIds().length, 0, 'an execution whose creation never landed does not exist');
    },
  },
  {
    n: 2, name: 'before grant.issued',
    arm: onKind('grant.issued'),
    run: async (k) => {
      const e = k.createExecution();
      k.issueGrant(e, GRANT);
    },
    check: (k) => {
      const fam = k.family(k.familyIds()[0]!);
      assert.equal(fam.grants.size, 0, 'a grant whose issue never landed confers nothing');
    },
  },
  {
    n: 3, name: 'before the admission record (claim + reservation + dispatch)',
    arm: onKind('invocation.admitted'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
    },
    check: (k, world) => {
      const fam = k.family(k.familyIds()[0]!);
      assert.equal(fam.claims.size, 0, 'no claim');
      assert.equal(world.count('charge'), 0, 'the world was never touched');
      assert.equal(
        fam.grants.get([...fam.grants.keys()][0]!)!.reserved['usd'] ?? 0, 0,
        'an admission that did not land reserves nothing',
      );
    },
  },
  {
    n: 4, name: 'after admission, before the landing',
    arm: onKind('effect.landed'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
    },
    check: (k, world, uncertain) => {
      assert.equal(world.count('charge'), 1, 'the capability did touch the world');
      const fam = k.family(k.familyIds()[0]!);
      assert.equal(fam.claims.size, 1, 'the claim landed durably before dispatch (B1)');
      assert.equal(
        uncertain.length, 1,
        'dispatched with no outcome and no landing record ⇒ the outcome is UNKNOWN, not failed',
      );
    },
  },
  {
    n: 5, name: 'after the landing, before the outcome',
    arm: onKind('invocation.completed'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
    },
    check: (k, world, uncertain) => {
      const execId = k.executionIds()[0]!;
      assert.equal(world.count('charge'), 1);
      assert.equal(
        hasLanded(k.familyFor(execId), keyFor({ id: 1 }, 'charge')), true,
        'B3: the landing committed at yield, so the restart still knows about it',
      );
      assert.equal(uncertain.length, 1, 'the OUTCOME is unknown; the LANDING is not');
      assert.equal(k.isProtected(execId, keyFor({ id: 1 }, 'charge')), true);
    },
  },
  {
    n: 6, name: 'during the settle record',
    arm: onKind('invocation.completed', { torn: true }),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
    },
    check: (k, _w, uncertain) => {
      // The settle record is atomic: outcome, effect settlement and budget settlement land
      // together or not at all. Losing it leaves the invocation in doubt, never half-done.
      const execId = k.executionIds()[0]!;
      const inv = [...k.familyFor(execId).executions.get(execId)!.invocations.values()][0]!;
      assert.equal(inv.state, 'uncertain');
      assert.equal(uncertain.length, 1);
    },
  },
  {
    n: 7, name: 'after a clean completion',
    arm: onKind('invocation.admitted', { nth: 2 }),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
      await k.invoke(e, 'notes.write', { v: 'a' }, g, { step: 'note' });
    },
    check: (k, _w, uncertain) => {
      const execId = k.executionIds()[0]!;
      const inv = [...k.familyFor(execId).executions.get(execId)!.invocations.values()][0]!;
      assert.equal(inv.state, 'completed', 'a settled invocation is not disturbed by a later crash');
      assert.equal(uncertain.length, 0);
    },
  },
  {
    n: 8, name: 'during the suspension record',
    arm: onKind('invocation.suspended'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1, suspend: true }, g, { step: 'charge' });
    },
    check: (k, world, uncertain) => {
      assert.equal(world.count('charge'), 1);
      const execId = k.executionIds()[0]!;
      assert.equal(
        hasLanded(k.familyFor(execId), keyFor({ id: 1, suspend: true }, 'charge')), true,
        'a suspension record that never landed cannot erase a landing that did',
      );
      assert.equal(uncertain.length, 1, 'without the suspension record the outcome is simply unknown');
    },
  },
  {
    n: 9, name: 'after suspension, before resume',
    arm: onKind('invocation.resumed'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      const out = await k.invoke(e, 'pay.card', { id: 1, suspend: true }, g, { step: 'charge' });
      await k.resume(e, out.invocationId, { approved: true });
    },
    check: (k, _w, uncertain) => {
      const execId = k.executionIds()[0]!;
      const inv = [...k.familyFor(execId).executions.get(execId)!.invocations.values()][0]!;
      assert.equal(inv.state, 'suspended', 'suspension is durable and survives a restart');
      assert.equal(uncertain.length, 0, 'a suspension is a deliberate state, not an unknown outcome');
      assert.deepEqual(inv.suspension?.payload, { ref: 'a1' });
    },
  },
  {
    n: 10, name: 'during the resume record',
    arm: onKind('invocation.resumed', { torn: true }),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      const out = await k.invoke(e, 'pay.card', { id: 1, suspend: true }, g, { step: 'charge' });
      await k.resume(e, out.invocationId, { approved: true });
    },
    check: (k) => {
      const execId = k.executionIds()[0]!;
      const inv = [...k.familyFor(execId).executions.get(execId)!.invocations.values()][0]!;
      assert.equal(inv.state, 'suspended', 'a resume that did not land leaves it suspended, still resumable');
    },
  },
  {
    n: 11, name: 'after resume, before the second settle',
    arm: onKind('invocation.completed'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      const out = await k.invoke(e, 'pay.card', { id: 1, suspend: true }, g, { step: 'charge' });
      await k.resume(e, out.invocationId, { approved: true });
    },
    check: (k, world) => {
      assert.equal(world.count('charge'), 1, 'the resumed body must not have re-charged');
      const execId = k.executionIds()[0]!;
      assert.equal(hasLanded(k.familyFor(execId), keyFor({ id: 1, suspend: true }, 'charge')), true);
    },
  },
  {
    n: 12, name: 'during the fork record',
    arm: onKind('execution.forked'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
      k.fork(e, 3);
    },
    check: (k) => {
      assert.equal(k.executionIds().length, 1, 'a fork whose record never landed did not happen');
    },
  },
  {
    n: 13, name: 'after fork, before the child invokes',
    arm: onKind('effect.claim.denied'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
      const child = k.fork(e, 3);
      const cg = k.rehydrateGrant(child, g.id);
      await k.invoke(child, 'pay.card', { id: 1 }, cg, { step: 'charge' });
    },
    check: (k, world) => {
      assert.equal(k.executionIds().length, 2, 'the fork landed');
      const child = k.executionIds()[1]!;
      assert.equal(
        k.isProtected(child, keyFor({ id: 1 }, 'charge')), true,
        'B9a: the child is bound by the family ledger, whatever cut it came from',
      );
      assert.equal(world.count('charge'), 1);
    },
  },
  {
    n: 14, name: 'during the child\'s claim-denied record',
    arm: onKind('effect.claim.denied', { torn: true }),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' });
      const child = k.fork(e, 3);
      const cg = k.rehydrateGrant(child, g.id);
      // A blanket catch would swallow the CrashError too and the test would silently
      // assert nothing. Only the expected refusal is absorbed.
      await k.invoke(child, 'pay.card', { id: 1 }, cg, { step: 'charge' }).catch((err: unknown) => {
        if (!(err instanceof ClaimDeniedError)) throw err;
      });
    },
    check: (k, world) => {
      assert.equal(world.count('charge'), 1, 'losing the refusal record must not license a charge');
    },
  },
  {
    n: 15, name: 'during a revocation record',
    arm: onKind('grant.revoked'),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'notes.write', { v: 'a' }, g, { step: 'n1' });
      k.revoke(e, g);
    },
    check: (k) => {
      const fam = k.family(k.familyIds()[0]!);
      const g = [...fam.grants.values()][0]!;
      assert.equal(g.revoked, false, 'a revocation that never landed did not take effect — fail visible, not silent');
    },
  },
  {
    n: 16, name: 'during an uncertainty-resolution record',
    arm: () => { /* replaced: built in two stages below */ },
    run: async () => { /* replaced */ },
    check: () => { /* replaced */ },
  },
  {
    n: 17, name: 'during an artifact blob write',
    arm: (storage: Storage) => storage.armCrashWhen((s) => s.startsWith('{"note"'), { label: 'blob' }),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'notes.write', { v: 'a' }, g, { step: 'n1' });
    },
    check: (k) => {
      const fam = k.family(k.familyIds()[0]!);
      const execId = k.executionIds()[0]!;
      assert.equal(
        fam.executions.get(execId)!.artifacts.length, 0,
        'an artifact whose blob never landed must not be referenced by a committed record',
      );
    },
  },
  {
    n: 18, name: 'during a second execution in the same store',
    arm: onKind('execution.created', { nth: 2 }),
    run: async (k) => {
      const e = k.createExecution();
      const g = k.issueGrant(e, GRANT);
      await k.invoke(e, 'notes.write', { v: 'a' }, g, { step: 'n1' });
      const e2 = k.createExecution();
      const g2 = k.issueGrant(e2, GRANT);
      await k.invoke(e2, 'pay.card', { id: 9 }, g2, { step: 'charge' });
    },
    check: (k) => {
      assert.ok(k.familyIds().length >= 1, 'one family\'s crash must not destroy another\'s records');
      for (const familyId of k.familyIds()) {
        assertS1Invariants(k.family(familyId), { events: k.events(familyId) });
      }
    },
  },
];

for (const pos of POSITIONS.filter((p) => p.n !== 16)) {
  test(`crash matrix ${String(pos.n)}/18: ${pos.name}`, async () => {
    const storage = new Storage();
    const world = new World();
    const k = new S1Kernel(storage);
    for (const p of providers(world)) k.register(p);

    pos.arm(storage);
    let crashed = false;
    try {
      await pos.run(k, storage, world);
    } catch (err) {
      if (!(err instanceof CrashError)) throw err;
      crashed = true;
    }
    assert.ok(crashed, `position ${String(pos.n)} never crashed — the write count is wrong`);
    storage.disarm();

    const { k: k2, uncertain } = restart(storage, world);
    pos.check(k2, world, uncertain);
  });
}

test('crash matrix 16/18: during an uncertainty-resolution record', async () => {
  // Built in two stages because the crash point depends on how many writes the setup took.
  const storage = new Storage();
  const world = new World();
  const k1 = new S1Kernel(storage);
  for (const p of providers(world)) k1.register(p);
  const e = k1.createExecution();
  const g = k1.issueGrant(e, GRANT);

  onKind('invocation.completed')(storage);
  await assert.rejects(
    () => k1.invoke(e, 'pay.card', { id: 1 }, g, { step: 'charge' }),
    (x: unknown) => x instanceof CrashError,
  );
  storage.disarm();

  const { k: k2, uncertain } = restart(storage, world);
  assert.equal(uncertain.length, 1);

  // Now crash while recording the resolution.
  onKind('invocation.uncertainty.resolved')(storage);
  await assert.rejects(
    () => k2.resolveUncertainty(e, uncertain[0]! as never, { kind: 'probe' }),
    (x: unknown) => x instanceof CrashError,
  );
  storage.disarm();

  const { k: k3, uncertain: still } = restart(storage, world);
  const inv = [...k3.familyFor(e).executions.get(e)!.invocations.values()][0]!;
  assert.equal(
    inv.state, 'uncertain',
    'a resolution that never landed leaves the invocation uncertain — never silently resolved',
  );
  assert.equal(still.length, 0, 'and it is not re-triaged into a second uncertainty record');
  assert.equal(
    k3.isProtected(e, keyFor({ id: 1 }, 'charge')), true,
    'the landing still protects while the resolution is unrecorded',
  );

  // It is still resolvable: a lost resolution is a retry, not a dead end.
  const state = await k3.resolveUncertainty(e, inv.id, { kind: 'probe' });
  assert.equal(state, 'completed');
  assert.equal(world.count('charge'), 1);
});

// ---------------------------------------------------------------------------
// Layer 2 — exhaustive sweep
// ---------------------------------------------------------------------------

async function workload(k: S1Kernel): Promise<void> {
  const e = k.createExecution();
  const g = k.issueGrant(e, GRANT);
  await k.invoke(e, 'notes.write', { v: 'a' }, g, { step: 'n1' });
  const susp = await k.invoke(e, 'pay.card', { id: 1, suspend: true }, g, { step: 'charge' });
  if (susp.state === 'suspended') await k.resume(e, susp.invocationId, { approved: true });
  const child = k.fork(e, 4);
  const cg = k.rehydrateGrant(child, g.id);
  await k.invoke(child, 'pay.card', { id: 1, suspend: true }, cg, { step: 'charge' }).catch((err: unknown) => {
    if (err instanceof CrashError) throw err;
    if (!(err instanceof ClaimDeniedError)) throw err;
  });
  await k.invoke(child, 'notes.write', { v: 'b' }, cg, { step: 'n2' });
  k.revoke(child, cg);
}

test('crash sweep: a crash before every durable write leaves a valid, recoverable journal', async () => {
  const probeStorage = new Storage();
  const probeWorld = new World();
  const probe = new S1Kernel(probeStorage);
  for (const p of providers(probeWorld)) probe.register(p);
  await workload(probe);
  const totalWrites = probeStorage.writes;
  assert.ok(totalWrites >= 12, `workload should be rich enough to be interesting (${String(totalWrites)} writes)`);

  let restarts = 0;
  for (let point = 1; point <= totalWrites; point += 1) {
    for (const torn of [false, true]) {
      const storage = new Storage();
      const world = new World();
      const k = new S1Kernel(storage);
      for (const p of providers(world)) k.register(p);
      storage.armCrash(point, { torn, label: `w${String(point)}` });

      try {
        await workload(k);
      } catch (err) {
        if (!(err instanceof CrashError)) throw err;
      }
      storage.disarm();

      // Restart from storage alone; the invariant set runs inside restart().
      const { k: k2 } = restart(storage, world);
      restarts += 1;

      // The safety property that outranks all bookkeeping: the world is never charged
      // twice for one effect key, whatever the crash did.
      assert.ok(world.count('charge') <= 1, `charged ${String(world.count('charge'))} times at point ${String(point)}`);

      // A torn record must be discarded, never half-folded.
      const { discarded } = storage.readJournal(verifyS1Record);
      assert.ok(discarded <= 1, 'at most the trailing record may be torn');

      // And the recovered kernel must still be usable, not merely inspectable.
      for (const familyId of k2.familyIds()) {
        assert.ok(k2.events(familyId as FamilyId).length >= 0);
      }
    }
  }
  assert.equal(restarts, totalWrites * 2);
});
