/**
 * B2 / B9b — the family-scoped grant ledger.
 *
 * B2: authority accounting must be keyed by grant id across the whole lineage tree.
 *     If a fork gets its own copy of the ledger, forking mints spending power.
 * B9b: every declared unit must be reserved and admission-checked, and capability-
 *     declared usage must be validated against the reservation before settling.
 *     Previously only the hardcoded `invocations` unit was enforced, so a capability
 *     could settle {tokens: 5_000_000} against a limit of 100 unchallenged.
 *
 * The through-line of both: authority is a fold over committed records, so it cannot be
 * reset by forking, forgotten by restarting, or overspent by asserting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, AuthorizationError, BudgetError } from '../src/s1-kernel.ts';
import { digest, foldAll, remaining } from '../src/s1-fold.ts';
import type { FamilyId } from '../src/s1-types.ts';
import { Storage } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectProposal, InvokeCtx,
} from '../src/types.ts';

/**
 * A capability that declares whatever usage the request tells it to.
 *
 * `tokens` is METERED: the provider reports authoritative consumption, so a declaration
 * below the reservation is believed and refunded. `credits` is UNMETERED: nobody measures
 * it, so the reservation is charged in full whatever the capability claims.
 */
function spender(id = 'work.unit'): CapabilityProvider {
  return {
    manifest: {
      id, version: '1.0.0',
      traits: {
        effectClass: 'local', probeable: false, compensatable: false, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      units: {
        tokens: { perInvocation: 10, metered: true },
        credits: { perInvocation: 5, metered: false },
      },
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as { declare?: Record<string, number>; fail?: boolean };
      if (req.declare !== undefined) yield { type: 'usage', units: req.declare };
      if (req.fail === true) return { status: 'failed', error: 'declined' };
      return { status: 'ok', output: { done: true } };
    },
  };
}

function setup(limits: Record<string, number>): {
  k: S1Kernel; storage: Storage; exec: ReturnType<S1Kernel['createExecution']>;
  grant: ReturnType<S1Kernel['issueGrant']>; familyId: FamilyId;
} {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(spender());
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, { rights: ['work'], limits });
  return { k, storage, exec, grant, familyId: k.familyFor(exec).familyId };
}

function assertLiveEqualsReplayed(k: S1Kernel, familyId: FamilyId): void {
  assert.equal(
    digest(foldAll(familyId, k.events(familyId))),
    digest(k.family(familyId)),
    'replayed state diverged from live state (B4 / S1-I3)',
  );
}

// ---------------------------------------------------------------------------
// B2 — one ledger per grant, for the whole lineage tree
// ---------------------------------------------------------------------------

test('B2/G1: a fork does not reset the budget', async () => {
  const f = setup({ invocations: 3, tokens: 1000, credits: 1000 });

  await f.k.invoke(f.exec, 'work.unit', { n: 1 }, f.grant, { step: 'a' });
  await f.k.invoke(f.exec, 'work.unit', { n: 2 }, f.grant, { step: 'b' });
  assert.equal(f.k.remainingFor(f.exec, f.grant.id, 'invocations'), 1);

  const child = f.k.fork(f.exec, f.k.familyFor(f.exec).executions.get(f.exec)!.seq);
  const childGrant = f.k.rehydrateGrant(child, f.grant.id);

  assert.equal(
    f.k.remainingFor(child, f.grant.id, 'invocations'), 1,
    'the child inherits the SPENT ledger, not a fresh copy of the limit',
  );
  await f.k.invoke(child, 'work.unit', { n: 3 }, childGrant, { step: 'c' });
  await assert.rejects(
    () => f.k.invoke(child, 'work.unit', { n: 4 }, childGrant, { step: 'd' }),
    (e: unknown) => e instanceof BudgetError,
  );
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B2/G2: sibling forks cannot mint authority between them', async () => {
  // The anti-minting property. If each sibling had its own ledger, N forks would multiply
  // a budget by N — the cheapest possible privilege escalation.
  const f = setup({ invocations: 4, tokens: 1000, credits: 1000 });
  const cut = f.k.familyFor(f.exec).executions.get(f.exec)!.seq;

  const siblings = [f.k.fork(f.exec, cut), f.k.fork(f.exec, cut), f.k.fork(f.exec, cut)];
  const grants = siblings.map((s) => f.k.rehydrateGrant(s, f.grant.id));

  let succeeded = 0;
  let denied = 0;
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < siblings.length; i += 1) {
      try {
        await f.k.invoke(siblings[i]!, 'work.unit', { round, i }, grants[i]!, { step: `s${round}-${i}` });
        succeeded += 1;
      } catch (e) {
        assert.ok(e instanceof BudgetError, `expected BudgetError, got ${String(e)}`);
        denied += 1;
      }
    }
  }
  assert.equal(succeeded, 4, 'the family may spend the limit exactly once, however many forks exist');
  assert.equal(denied, 5);
  assert.equal(f.k.remainingFor(siblings[0]!, f.grant.id, 'invocations'), 0);
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B2/G3: the ledger survives restart', async () => {
  const f = setup({ invocations: 3, tokens: 100, credits: 1000 });
  await f.k.invoke(f.exec, 'work.unit', { n: 1 }, f.grant, { step: 'a', estimate: { tokens: 40 } });
  const before = f.k.remainingFor(f.exec, f.grant.id, 'tokens');

  const { kernel: k2 } = S1Kernel.recover(f.storage, [spender()]);
  assert.equal(
    k2.remainingFor(f.exec, f.grant.id, 'tokens'), before,
    'a budget held only in memory is a budget that resets at every restart (I25)',
  );

  const g2 = k2.rehydrateGrant(f.exec, f.grant.id);
  await k2.invoke(f.exec, 'work.unit', { n: 2 }, g2, { step: 'b', estimate: { tokens: 40 } });
  await assert.rejects(
    () => k2.invoke(f.exec, 'work.unit', { n: 3 }, g2, { step: 'c', estimate: { tokens: 40 } }),
    (e: unknown) => e instanceof BudgetError,
  );
  assertLiveEqualsReplayed(k2, f.familyId);
});

// ---------------------------------------------------------------------------
// B9b — every unit, reserved and validated
// ---------------------------------------------------------------------------

test('B9b/G4: units other than `invocations` are admission-checked, not advisory', async () => {
  const f = setup({ invocations: 50, tokens: 100, credits: 1000 });

  // A metered unit settles at what the provider reports, so an over-estimate is refunded.
  await f.k.invoke(
    f.exec, 'work.unit', { declare: { tokens: 25 } }, f.grant,
    { step: 'a', estimate: { tokens: 60 } },
  );
  assert.equal(f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 75, 'metered: charged what was used');

  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 2 }, f.grant, { step: 'b', estimate: { tokens: 200 } }),
    (e: unknown) => e instanceof BudgetError && /tokens/.test(e.message),
    'an over-limit estimate must be refused at admission, before any work happens',
  );
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B9b/G4b: budget enforcement is not opt-in — omitting an estimate reserves the floor', async () => {
  // The hole this closes (docs/20 F-15): reservations were built from the caller's
  // `estimate` alone, so any unit the caller declined to estimate was never reserved and
  // therefore never settled. Token budgets could be bypassed by simply not mentioning
  // tokens. The capability's manifest now sets a floor the caller cannot lower.
  const f = setup({ invocations: 100, tokens: 35, credits: 1000 });

  for (let i = 0; i < 3; i += 1) {
    await f.k.invoke(f.exec, 'work.unit', { n: i }, f.grant, { step: `s${i}` });
  }
  assert.equal(f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 5, '3 x the 10-token floor');

  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 9 }, f.grant, { step: 's9' }),
    (e: unknown) => e instanceof BudgetError,
    'a caller that never estimates must still run out',
  );
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B9b/G4c: an unmetered unit is charged the reservation, not the capability\'s word', async () => {
  // The pure-proposer principle applied to accounting. If declaring less than the
  // reservation were believed for a unit nobody measures, a capability declaring zero
  // would run forever against a finite budget — a safety property resting on the honesty
  // of untrusted code.
  const f = setup({ invocations: 100, tokens: 10_000, credits: 20 });

  await f.k.invoke(f.exec, 'work.unit', { declare: { credits: 0 } }, f.grant, { step: 'a' });
  assert.equal(
    f.k.remainingFor(f.exec, f.grant.id, 'credits'), 15,
    'declaring zero for an unmetered unit must not refund the reservation',
  );

  await f.k.invoke(f.exec, 'work.unit', { declare: { credits: 0 } }, f.grant, { step: 'b' });
  await f.k.invoke(f.exec, 'work.unit', { declare: { credits: 0 } }, f.grant, { step: 'c' });
  await f.k.invoke(f.exec, 'work.unit', { declare: { credits: 0 } }, f.grant, { step: 'd' });
  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { declare: { credits: 0 } }, f.grant, { step: 'e' }),
    (e: unknown) => e instanceof BudgetError,
    'a lying capability must still exhaust an unmetered budget',
  );
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B9b/G4d: a metered unit is trusted downward — the stated limit of the design', async () => {
  // Stated, not hidden. For a metered unit the kernel believes the provider's reported
  // consumption, because the authority that reports usage is the authority that bills for
  // it. A capability that lies downward about a metered unit under-charges the ledger.
  // The kernel's HARD guarantee is the admission-time one: no invocation is admitted
  // without room for its reservation. Cumulative accuracy for metered units rests on the
  // provider, and no kernel that cannot measure tokens itself can do better.
  const f = setup({ invocations: 100, tokens: 30, credits: 1000 });

  for (let i = 0; i < 5; i += 1) {
    await f.k.invoke(f.exec, 'work.unit', { declare: { tokens: 0 } }, f.grant, { step: `s${i}` });
  }
  assert.equal(
    f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 30,
    'documented limit: a dishonest metered declaration under-charges',
  );
  // What the kernel still guarantees, even here.
  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 1 }, f.grant, { step: 'big', estimate: { tokens: 31 } }),
    (e: unknown) => e instanceof BudgetError,
    'no invocation is ever admitted without room for its reservation',
  );
});

test('B9b/G5: declared usage cannot exceed the reservation', async () => {
  // B9b's original reproduction: a capability declaring {tokens: 5_000_000} against a
  // limit of 100 had it settled unchallenged. Usage is now capped at what was held, and
  // the overrun is journaled rather than silently clipped.
  const f = setup({ invocations: 50, tokens: 100, credits: 1000 });

  const out = await f.k.invoke(
    f.exec, 'work.unit', { declare: { tokens: 5_000_000 } }, f.grant,
    { step: 'greedy', estimate: { tokens: 10 } },
  );
  assert.equal(out.state, 'completed');

  const ledger = f.k.familyFor(f.exec).grants.get(f.grant.id)!;
  assert.equal(ledger.settled['tokens'], 10, 'settlement is capped at the reservation');
  assert.equal(f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 90);

  const denials = f.k.events(f.familyId).filter(
    (e) => e.kind === 'policy.denied' && e.payload['reason'] === 'usage-exceeds-reservation',
  );
  assert.equal(denials.length, 1, 'the overrun must be recorded, not silently clipped');
  assert.equal(denials[0]!.payload['declared'], 5_000_000);
  assert.equal(denials[0]!.payload['reserved'], 10);
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B9b/G6: a failed invocation releases its reservation', async () => {
  // Reserve-at-lease / settle-at-outcome (amendment A2). If a failure kept its
  // reservation, every failure would leak budget until the grant was unusable.
  const f = setup({ invocations: 10, tokens: 100, credits: 100 });

  await f.k.invoke(f.exec, 'work.unit', { fail: true }, f.grant, { step: 'x', estimate: { tokens: 50 } });
  assert.equal(
    f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 100,
    'a failure that consumed nothing must not hold budget hostage',
  );
  assert.equal(
    f.k.remainingFor(f.exec, f.grant.id, 'credits'), 100,
    'not even the unmetered floor: a retry must not eat the budget',
  );
  const ledger = f.k.familyFor(f.exec).grants.get(f.grant.id)!;
  assert.equal(ledger.reserved['tokens'] ?? 0, 0, 'no reservation may outlive its invocation');
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B9b/G7: reservations are held for the duration of an in-flight invocation', async () => {
  // The reservation must exist BETWEEN admission and outcome, or two concurrent
  // invocations could each pass an admission check against the same unspent budget.
  const f = setup({ invocations: 10, tokens: 100, credits: 100 });

  const a = f.k.invoke(f.exec, 'work.unit', { n: 1 }, f.grant, { step: 'a', estimate: { tokens: 60 } });
  // Admission is synchronous, so by here the reservation is already committed.
  assert.equal(f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 40);
  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 2 }, f.grant, { step: 'b', estimate: { tokens: 60 } }),
    (e: unknown) => e instanceof BudgetError,
    'a second invocation must not be admitted against budget the first is holding',
  );
  await a;
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B9b/G4e: the metering policy is negotiated at admission and journaled, not re-read at settlement', async () => {
  // docs/20 F-20, found by adversarial review. `metered` decides an authoritative ledger
  // movement, so reading it from the in-process capability registry at settlement made a
  // committed invocation's cost depend on a manifest that a restart re-supplies from the
  // caller. Same journal, same capability id and version, different manifest object, and
  // the settled figure changed.
  //
  // It is now journaled at admission for the same reason `effectClass` is.
  const storage = new Storage();
  const k1 = new S1Kernel(storage);
  k1.register(spender());
  const exec = k1.createExecution();
  const familyId = k1.familyFor(exec).familyId;
  const grant = k1.issueGrant(exec, { rights: ['work'], limits: { invocations: 20, tokens: 500, credits: 500 } });

  // Admit under the honest manifest: tokens metered, floor 10.
  const out = await k1.invoke(exec, 'work.unit', { suspendHere: true }, grant, { step: 'a', estimate: { tokens: 100 } });
  void out;

  // The admission record must carry the negotiated policy.
  const admitted = k1.events(familyId).find((e) => e.kind === 'invocation.admitted')!;
  assert.deepEqual(
    admitted.payload['meteredUnits'], ['tokens'],
    'the negotiated metering policy must be in the record, beside effectClass',
  );

  // Restart, re-supplying a manifest that lies: same id, same version, tokens now unmetered.
  const liar: CapabilityProvider = {
    ...spender(),
    manifest: {
      ...spender().manifest,
      units: {
        tokens: { perInvocation: 10, metered: false },
        credits: { perInvocation: 5, metered: false },
      },
    },
  };
  const { kernel: k2 } = S1Kernel.recover(storage, [liar]);
  assert.deepEqual(
    k2.familyFor(exec).executions.get(exec)!.invocations.get(admitted.invocationId!)!.meteredUnits,
    ['tokens'],
    'the policy survives recovery from the journal, not from the re-supplied manifest',
  );
  assertLiveEqualsReplayed(k2, familyId);
});

// ---------------------------------------------------------------------------
// Attenuation and revocation over the family ledger
// ---------------------------------------------------------------------------

test('B2/G8: attenuation cannot widen rights or limits', async () => {
  const f = setup({ invocations: 10, tokens: 100, credits: 100 });

  assert.throws(
    () => f.k.attenuate(f.exec, f.grant, { rights: ['work', 'admin'], limits: { tokens: 10 } }),
    (e: unknown) => e instanceof AuthorizationError,
    'a child grant may never add a right its parent lacks',
  );
  assert.throws(
    () => f.k.attenuate(f.exec, f.grant, { rights: ['work'], limits: { tokens: 500 } }),
    (e: unknown) => e instanceof AuthorizationError,
    'a child grant may never exceed the parent remaining',
  );
});

test('B2/G9: spending through a child grant draws down the parent ledger', async () => {
  const f = setup({ invocations: 10, tokens: 100, credits: 100 });
  const child = f.k.attenuate(f.exec, f.grant, { rights: ['work'], limits: { invocations: 5, tokens: 50, credits: 50 } });

  await f.k.invoke(f.exec, 'work.unit', { declare: { tokens: 30 } }, child, { step: 'a', estimate: { tokens: 30 } });

  assert.equal(f.k.remainingFor(f.exec, child.id, 'tokens'), 20, 'the child sees its own smaller limit');
  assert.equal(
    f.k.remainingFor(f.exec, f.grant.id, 'tokens'), 70,
    'and the parent is debited too: delegation spends the delegator\'s budget',
  );
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B2/G10: the effective limit is the minimum along the whole chain', async () => {
  const f = setup({ invocations: 10, tokens: 100, credits: 100 });
  const mid = f.k.attenuate(f.exec, f.grant, { rights: ['work'], limits: { invocations: 5, tokens: 40, credits: 40 } });
  const leaf = f.k.attenuate(f.exec, mid, { rights: ['work'], limits: { invocations: 5, tokens: 40, credits: 40 } });

  await f.k.invoke(f.exec, 'work.unit', { declare: { tokens: 30 } }, leaf, { step: 'a', estimate: { tokens: 30 } });
  assert.equal(remaining(f.k.familyFor(f.exec), leaf.id, 'tokens'), 10);

  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 2 }, leaf, { step: 'b', estimate: { tokens: 20 } }),
    (e: unknown) => e instanceof BudgetError,
    'an ancestor running out must stop the descendant',
  );
});

test('B2/G11: revocation is transitive and survives restart', async () => {
  const f = setup({ invocations: 10, tokens: 100, credits: 100 });
  const mid = f.k.attenuate(f.exec, f.grant, { rights: ['work'], limits: { invocations: 5, tokens: 40, credits: 40 } });
  const leaf = f.k.attenuate(f.exec, mid, { rights: ['work'], limits: { invocations: 3, tokens: 20, credits: 20 } });

  f.k.revoke(f.exec, mid);
  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 1 }, leaf, { step: 'a' }),
    (e: unknown) => e instanceof AuthorizationError,
    'revoking a grant must revoke everything attenuated from it',
  );

  const { kernel: k2 } = S1Kernel.recover(f.storage, [spender()]);
  const leaf2 = k2.rehydrateGrant(f.exec, leaf.id);
  await assert.rejects(
    () => k2.invoke(f.exec, 'work.unit', { n: 2 }, leaf2, { step: 'b' }),
    (e: unknown) => e instanceof AuthorizationError,
    'revocation held only in memory is revocation that lapses at restart (I25)',
  );
  assertLiveEqualsReplayed(k2, f.familyId);
});

test('B2/G12: a rehydrated handle carries no authority the ledger does not still grant', async () => {
  // Rehydration re-mints a handle for a grant in the recovered ledger. It must not become
  // a way to escape revocation, expiry or exhaustion — the handle is a reference, never
  // the authority itself.
  const f = setup({ invocations: 1, tokens: 1000, credits: 1000 });
  await f.k.invoke(f.exec, 'work.unit', { n: 1 }, f.grant, { step: 'a' });

  const { kernel: k2 } = S1Kernel.recover(f.storage, [spender()]);
  const g2 = k2.rehydrateGrant(f.exec, f.grant.id);
  await assert.rejects(
    () => k2.invoke(f.exec, 'work.unit', { n: 2 }, g2, { step: 'b' }),
    (e: unknown) => e instanceof BudgetError,
    'a fresh handle must not reset an exhausted budget',
  );

  // And a grant that does not exist in this family cannot be rehydrated at all.
  assert.throws(
    () => k2.rehydrateGrant(f.exec, 'grant_forged' as never),
    (e: unknown) => e instanceof AuthorizationError,
  );
});

test('B2/G13: a forged handle is refused even with a valid grant id', async () => {
  // Authority is object identity in the kernel's private registry, not a token field.
  const f = setup({ invocations: 10, tokens: 1000, credits: 1000 });
  const forged = Object.create(Object.getPrototypeOf(f.grant) as object) as typeof f.grant;
  Object.assign(forged, { id: f.grant.id });

  await assert.rejects(
    () => f.k.invoke(f.exec, 'work.unit', { n: 1 }, forged, { step: 'a' }),
    (e: unknown) => e instanceof AuthorizationError,
    'reading a grant id off a journal event must not confer authority',
  );
});
