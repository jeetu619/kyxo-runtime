/**
 * B9a — the protected-effect ledger over the lineage tree.
 *
 * B9a's ratified resolution: "landed irreversible/compensatable effects need a
 * lineage-tree-scoped durable ledger rooted at the ancestral execution, consulted
 * REGARDLESS OF WHICH CUT A CHILD CAME FROM."
 *
 * The question these tests settle is the scope of that ledger. Two candidate answers:
 *
 *   ancestor-path — an execution is bound only by effects landed by itself and its
 *                   ancestors, at or before the seq it branched away. Siblings are
 *                   treated as divergent world-lines.
 *   lineage-tree  — an execution is bound by every exclusive effect landed anywhere in
 *                   the family, regardless of topology.
 *
 * The deciding argument is not aesthetic. THE EXTERNAL WORLD IS NOT FORKED. A lineage
 * tree is bookkeeping; a charged card is a fact. If branch A really charged the card,
 * branch B charging it again charges a real customer twice, and no statement about
 * divergent world-lines makes that acceptable.
 *
 * L1 below is written against the world, not against the topology, and it is the test
 * that falsified the ancestor-path design (docs/20 F-12).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError } from '../src/s1-kernel.ts';
import { digest, foldAll, protectionFor } from '../src/s1-fold.ts';
import type { FamilyId } from '../src/s1-types.ts';
import { Storage, CrashError, sha } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectClass,
  EffectKey, EffectProposal, ExecutionId, InvokeCtx,
} from '../src/types.ts';

class World {
  readonly applied = new Map<string, number>();
  apply(d: string): void { this.applied.set(d, (this.applied.get(d) ?? 0) + 1); }
  count(d: string): number { return this.applied.get(d) ?? 0; }
}

function charger(world: World, effectClass: EffectClass = 'external-irreversible'): CapabilityProvider {
  return {
    manifest: {
      id: 'pay.card', version: '1.0.0',
      traits: {
        effectClass, probeable: true, compensatable: false, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
    },
    async *invoke(_ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      world.apply('charge');
      yield { type: 'external', descriptor: 'charge', landed: true };
      return { status: 'ok', output: { receipt: 'r1' } };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'unknown'; },
  };
}

/** The effect key the kernel derives for a given call. Mirrors the kernel's recipe. */
function keyFor(request: unknown, step = 'charge'): EffectKey {
  return sha({ cap: 'pay.card', step, request }) as EffectKey;
}

function assertLiveEqualsReplayed(k: S1Kernel, familyId: FamilyId): void {
  assert.equal(
    digest(foldAll(familyId, k.events(familyId))),
    digest(k.family(familyId)),
    'replayed state diverged from live state (B4 / S1-I3)',
  );
}

// ---------------------------------------------------------------------------
// L1 — the falsifying test: a fork from a cut BEFORE the charge
// ---------------------------------------------------------------------------

test('B9a/L1: a fork from a cut before the charge cannot charge again', async () => {
  // This is B9a's original reproduction, rebuilt on the S1 record format. The child is
  // forked from a point at which the effect had not yet happened, so nothing in the
  // child's own inherited state knows about it. Only a ledger consulted across the whole
  // lineage tree can stop it.
  const storage = new Storage();
  const world = new World();
  const k = new S1Kernel(storage);
  k.register(charger(world));

  const parent = k.createExecution();
  const familyId = k.familyFor(parent).familyId;
  const grant = k.issueGrant(parent, { rights: ['pay'], limits: { invocations: 50, usd: 1000 } });

  const cutBeforeCharge = k.familyFor(parent).executions.get(parent)!.seq;
  await k.invoke(parent, 'pay.card', { amount: 10 }, grant, { step: 'charge' });
  assert.equal(world.count('charge'), 1);

  const child = k.fork(parent, cutBeforeCharge);
  const childGrant = k.rehydrateGrant(child, grant.id);

  await assert.rejects(
    () => k.invoke(child, 'pay.card', { amount: 10 }, childGrant, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'a fork from before the charge must still be bound by it',
  );
  assert.equal(world.count('charge'), 1, 'the card must be charged exactly once');
  assert.equal(k.isProtected(child, keyFor({ amount: 10 })), true);
  assertLiveEqualsReplayed(k, familyId);
});

// ---------------------------------------------------------------------------
// L2 — siblings: the case that decides the scope question
// ---------------------------------------------------------------------------

test('B9a/L2: a sibling fork cannot repeat an effect its sibling landed', async () => {
  // Under ancestor-path scoping this passes only by accident (the family-wide claim
  // table blocks it while `protectionFor` says the sibling is unbound) — two mechanisms
  // answering the same question differently. L3 removes the accident.
  const storage = new Storage();
  const world = new World();
  const k = new S1Kernel(storage);
  k.register(charger(world));

  const parent = k.createExecution();
  const familyId = k.familyFor(parent).familyId;
  const grant = k.issueGrant(parent, { rights: ['pay'], limits: { invocations: 50, usd: 1000 } });
  const cut = k.familyFor(parent).executions.get(parent)!.seq;

  const a = k.fork(parent, cut);
  const b = k.fork(parent, cut);
  const ga = k.rehydrateGrant(a, grant.id);
  const gb = k.rehydrateGrant(b, grant.id);

  await k.invoke(a, 'pay.card', { amount: 10 }, ga, { step: 'charge' });
  assert.equal(world.count('charge'), 1);

  await assert.rejects(
    () => k.invoke(b, 'pay.card', { amount: 10 }, gb, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1, 'siblings share one world');

  // Coherence: the two mechanisms that can refuse an effect must agree about who is
  // bound. If `isProtected` says "free" while the claim table says "taken", the design
  // has two answers to one question and the safer one is winning by luck.
  assert.equal(
    k.isProtected(b, keyFor({ amount: 10 })), true,
    'protection and the claim table must agree: a landed exclusive effect binds the family',
  );
  assertLiveEqualsReplayed(k, familyId);
});

// ---------------------------------------------------------------------------
// L3 — the accident removed: claim cleared, landed record retained
// ---------------------------------------------------------------------------

test('B9a/L3: abandoning an uncertain outcome does not license repeating a landed effect', async () => {
  // The claim table is not a reliable second line of defence, because a claim can be
  // legitimately cleared while the landed record remains. Sequence:
  //   1. the charge lands durably, then the process dies before recording an outcome
  //   2. recovery marks the invocation uncertain
  //   3. an operator resolves it `abandon-failed` — an assertion about the OUTCOME
  //   4. a fork then attempts the same charge
  // Step 3 must not erase step 1. An operator may declare an outcome unknown-to-failed;
  // no operator assertion can un-charge a card that a durable record says was charged.
  const storage = new Storage();
  const world = new World();
  const cap = charger(world);
  const k1 = new S1Kernel(storage);
  k1.register(cap);

  const parent = k1.createExecution();
  const grant = k1.issueGrant(parent, { rights: ['pay'], limits: { invocations: 50, usd: 1000 } });
  const cut = k1.familyFor(parent).executions.get(parent)!.seq;

  // Writes: 1 execution.created, 2 grant.issued, 3 admission, 4 effect.landed, 5 settle.
  // Crash at 5 leaves the landing durable and the outcome unrecorded.
  storage.armCrash(5, { label: 'settle' });
  await assert.rejects(
    () => k1.invoke(parent, 'pay.card', { amount: 10 }, grant, { step: 'charge' }),
    (e: unknown) => e instanceof CrashError,
  );
  storage.disarm();
  assert.equal(world.count('charge'), 1);

  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [cap]);
  assert.equal(uncertain.length, 1);
  const familyId = k2.familyFor(parent).familyId;

  // The disposition itself must be refused: the disagreement is about the OUTCOME, and
  // the record is about the WORLD. "It failed" is not available once a landing is durable.
  await assert.rejects(
    () => k2.resolveUncertainty(parent, uncertain[0]!, { kind: 'abandon-failed', authority: 'operator:test' }),
    /durable landing/,
    'an operator may not declare a recorded landing to have failed',
  );

  // The honest disposition given a recorded landing.
  const state = await k2.resolveUncertainty(parent, uncertain[0]!, { kind: 'adopt-landed', authority: 'operator:test' });
  assert.equal(state, 'completed');

  // The landed record is durable truth and must still bind the family.
  assert.equal(
    k2.isProtected(parent, keyFor({ amount: 10 })), true,
    'a landed effect stays protected regardless of what the outcome was later declared to be',
  );

  const child = k2.fork(parent, cut);
  const gchild = k2.rehydrateGrant(child, grant.id);
  await assert.rejects(
    () => k2.invoke(child, 'pay.card', { amount: 10 }, gchild, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1, 'the card must not be charged twice');
  assertLiveEqualsReplayed(k2, familyId);
});

test('B9a/L3b: the fold refuses to free a landed key even if the record says otherwise', () => {
  // The kernel refuses to WRITE a contradicting resolution (L3). The fold must be correct
  // on its own anyway: it is the authority for derived state, and a buggy or hostile
  // writer must not be able to talk it out of a landing. This synthesises exactly the
  // record the kernel now refuses to emit and folds it directly.
  const familyId = 'fam_1' as FamilyId;
  const execId = 'exec_1' as ExecutionId;
  const key = keyFor({ amount: 10 });
  let seq = 0;
  const ev = (kind: string, payload: Record<string, unknown>) => ({
    id: `ev_${++seq}`, seq, kind, schemaVersion: 1, protocolVersion: 'test',
    executionId: execId, familyId, invocationId: 'inv_1', correlationId: 'c1',
    actorId: 'kernel', occurredAt: seq, payload, payloadHash: 'h',
    integrity: { prev: 'p', self: `s${seq}` },
  }) as never;

  const fam = foldAll(familyId, [
    ev('execution.created', { definitionHash: 'D1' }),
    ev('effect.claimed', { claimId: 'cl_1', effectKey: key, effectClass: 'external-irreversible', exclusive: true }),
    ev('effect.landed', { effectKey: key, effectClass: 'external-irreversible', descriptor: 'charge' }),
    ev('invocation.uncertain', { effectKey: key, effectClass: 'external-irreversible', landed: true }),
    // The forged record: resolves to failed, and claims nothing landed.
    ev('invocation.uncertainty.resolved', {
      disposition: 'abandon-failed', resolved: 'failed', effectKey: key,
      effectClass: 'external-irreversible', landed: false,
    }),
  ]);

  assert.equal(fam.claims.get(key)?.state, 'settled', 'the claim must survive as protection');
  assert.equal(protectionFor(fam, key).protected, true, 'the landing still binds the family');
});

// ---------------------------------------------------------------------------
// L4 — what protection must NOT do
// ---------------------------------------------------------------------------

test('B9a/L4: protection binds the family, never a different family', async () => {
  // Kernel dedup scope is the lineage tree. Two unrelated runs charging the same card is
  // a real-world concern answered by caller-supplied idempotency keys (which change the
  // request and therefore the effect key), not by kernel state shared across runs.
  const storage = new Storage();
  const world = new World();
  const k = new S1Kernel(storage);
  k.register(charger(world));

  const runA = k.createExecution();
  const gA = k.issueGrant(runA, { rights: ['pay'], limits: { invocations: 5, usd: 100 } });
  await k.invoke(runA, 'pay.card', { amount: 10 }, gA, { step: 'charge' });

  const runB = k.createExecution();
  const gB = k.issueGrant(runB, { rights: ['pay'], limits: { invocations: 5, usd: 100 } });
  const out = await k.invoke(runB, 'pay.card', { amount: 10 }, gB, { step: 'charge' });

  assert.equal(out.state, 'completed', 'a separate run is a separate unit of dedup');
  assert.equal(world.count('charge'), 2);
  assert.equal(k.isProtected(runB, keyFor({ amount: 10 })), true, 'within run B it is now protected');
});

test('B9a/L5: non-exclusive classes are not protected by the ledger', async () => {
  // Only classes that cannot be safely repeated take exclusive claims. A `local` effect
  // landing must not permanently occupy its key.
  const storage = new Storage();
  const world = new World();
  const k = new S1Kernel(storage);
  k.register(charger(world, 'external-idempotent'));

  const exec = k.createExecution();
  const g = k.issueGrant(exec, { rights: ['pay'], limits: { invocations: 5 } });
  await k.invoke(exec, 'pay.card', { amount: 10 }, g, { step: 'charge' });

  assert.equal(
    k.isProtected(exec, keyFor({ amount: 10 })), false,
    'idempotent effects are repeatable by declaration; the ledger must not bind them',
  );
});

// ---------------------------------------------------------------------------
// L6 — the ledger survives restart (I25)
// ---------------------------------------------------------------------------

test('B9a/L6: the protected-effect ledger survives restart and rebinds forks', async () => {
  const storage = new Storage();
  const world = new World();
  const cap = charger(world);
  const k1 = new S1Kernel(storage);
  k1.register(cap);

  const parent = k1.createExecution();
  const grant = k1.issueGrant(parent, { rights: ['pay'], limits: { invocations: 50, usd: 1000 } });
  const cut = k1.familyFor(parent).executions.get(parent)!.seq;
  await k1.invoke(parent, 'pay.card', { amount: 10 }, grant, { step: 'charge' });

  // Restart: nothing but the journal survives.
  const { kernel: k2 } = S1Kernel.recover(storage, [cap]);
  const familyId = k2.familyFor(parent).familyId;
  assert.equal(k2.isProtected(parent, keyFor({ amount: 10 })), true);

  const child = k2.fork(parent, cut);
  const gchild = k2.rehydrateGrant(child, grant.id);
  await assert.rejects(
    () => k2.invoke(child, 'pay.card', { amount: 10 }, gchild, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'protection held only in memory is protection that lasts until the next restart (I25)',
  );
  assert.equal(world.count('charge'), 1);
  assertLiveEqualsReplayed(k2, familyId);
});

// ---------------------------------------------------------------------------
// L7 — the fold is the only source of the answer
// ---------------------------------------------------------------------------

test('B9a/L7: protection is a query over folded records, not a stored list', async () => {
  const storage = new Storage();
  const world = new World();
  const k = new S1Kernel(storage);
  k.register(charger(world));

  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const g = k.issueGrant(exec, { rights: ['pay'], limits: { invocations: 5, usd: 100 } });
  await k.invoke(exec, 'pay.card', { amount: 10 }, g, { step: 'charge' });

  // Reconstructed purely from the journal by an independent fold — no kernel involved.
  const replayed = foldAll(familyId, k.events(familyId));
  assert.equal(
    protectionFor(replayed, keyFor({ amount: 10 })).protected, true,
    'a fold of the journal alone must reach the same protection answer as the live kernel',
  );
});
