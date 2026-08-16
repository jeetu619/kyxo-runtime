/**
 * B3 — the landed-external-effect lifecycle, and yield/suspension semantics.
 *
 * B3's defect: a landed external effect was held as an in-memory CANDIDATE until the
 * invocation settled. Anything that ended the invocation without settling — a suspension,
 * a crash, an exception — discarded the candidate, and the journal then said an effect
 * that really happened never happened.
 *
 * The revision: a landing commits AT YIELD. From the instant the capability tells the
 * kernel the world was touched, that is durable truth, and nothing downstream can retract
 * it. These tests take the landing through every exit an invocation has.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError, S1Error } from '../src/s1-kernel.ts';
import { digest, foldAll, hasLanded } from '../src/s1-fold.ts';
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

/**
 * A capability whose behaviour after the landing is driven by the request, so one fixture
 * can drive the landing through every exit path.
 */
function payer(world: World, opts: { skipOnResume?: boolean } = {}): CapabilityProvider {
  return {
    manifest: {
      id: 'pay.card', version: '1.0.0',
      traits: {
        effectClass: 'external-irreversible', probeable: true, compensatable: true,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'payments.charge', fields: ['after'] },
      units: { usd: { perInvocation: 1, metered: true } },
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as { after?: 'suspend' | 'throw' | 'fail' | 'ok'; };
      const resuming = ctx.resume !== undefined;

      // A well-behaved capability consults ctx.resume and does not repeat work.
      if (!(resuming && opts.skipOnResume === true)) {
        world.apply('charge');
        yield { type: 'external', descriptor: 'charge', landed: true };
      }

      if (resuming) return { status: 'ok', output: { resumed: true } };
      switch (req.after) {
        case 'suspend': return { status: 'suspend', reason: 'awaiting-approval', payload: { ref: 'appr-1' } };
        case 'throw': throw new Error('provider exploded after charging');
        case 'fail': return { status: 'failed', error: 'downstream rejected' };
        default: return { status: 'ok', output: { receipt: 'r1' } };
      }
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'landed'; },
    async compensate(): Promise<'compensated' | 'failed'> { world.apply('refund'); return 'compensated'; },
  };
}

function keyFor(request: unknown, step = 'charge'): EffectKey {
  return resolveEffectIdentity({
    capabilityId: 'pay.card', effectClass: 'external-irreversible', request,
    schema: { operation: 'payments.charge', fields: ['after'] },
  }).key;
}

function setup(world: World, opts: { skipOnResume?: boolean } = {}): {
  k: S1Kernel; storage: Storage; exec: ReturnType<S1Kernel['createExecution']>;
  grant: ReturnType<S1Kernel['issueGrant']>; familyId: FamilyId;
} {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payer(world, opts));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, { rights: ['pay'], limits: { invocations: 50, usd: 500 } });
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
// E1–E4: every exit an invocation has, with a landing already recorded
// ---------------------------------------------------------------------------

test('B3/E1: a landing survives suspension', async () => {
  const world = new World();
  const f = setup(world);

  const out = await f.k.invoke(f.exec, 'pay.card', { after: 'suspend' }, f.grant, { step: 'charge' });
  assert.equal(out.state, 'suspended');
  assert.equal(world.count('charge'), 1);

  const key = keyFor({ after: 'suspend' });
  assert.equal(hasLanded(f.k.familyFor(f.exec), key), true, 'the landing is durable while suspended');
  assert.equal(f.k.isProtected(f.exec, key), true, 'and it protects while suspended');
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B3/E2: a landing survives an exception thrown after the yield', async () => {
  const world = new World();
  const f = setup(world);

  const out = await f.k.invoke(f.exec, 'pay.card', { after: 'throw' }, f.grant, { step: 'charge' });
  assert.equal(out.state, 'failed');
  assert.equal(world.count('charge'), 1);

  const key = keyFor({ after: 'throw' });
  assert.equal(hasLanded(f.k.familyFor(f.exec), key), true, 'a thrown provider cannot un-charge a card');
  assert.equal(f.k.isProtected(f.exec, key), true);

  // The failure must not free the key for a retry that would charge again.
  await assert.rejects(
    () => f.k.invoke(f.exec, 'pay.card', { after: 'throw' }, f.grant, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1);
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B3/E3: a landing survives a declared failure', async () => {
  const world = new World();
  const f = setup(world);

  const out = await f.k.invoke(f.exec, 'pay.card', { after: 'fail' }, f.grant, { step: 'charge' });
  assert.equal(out.state, 'failed');
  const key = keyFor({ after: 'fail' });
  assert.equal(
    hasLanded(f.k.familyFor(f.exec), key), true,
    'a capability reporting failure AFTER the world was touched is reporting its own outcome, not the world\'s',
  );
  assert.equal(f.k.isProtected(f.exec, key), true);
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B3/E4: a landing survives a crash between the yield and the outcome', async () => {
  const world = new World();
  const storage = new Storage();
  const cap = payer(world);
  const k1 = new S1Kernel(storage);
  k1.register(cap);
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, { rights: ['pay'], limits: { invocations: 50, usd: 500 } });

  // Writes: 1 created, 2 grant, 3 admission, 4 effect.landed, 5 settle. Crash at 5.
  storage.armCrash(5, { label: 'settle' });
  await assert.rejects(
    () => k1.invoke(exec, 'pay.card', { after: 'ok' }, grant, { step: 'charge' }),
    (e: unknown) => e instanceof CrashError,
  );
  storage.disarm();

  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [cap]);
  const key = keyFor({ after: 'ok' });
  assert.equal(
    hasLanded(k2.familyFor(exec), key), true,
    'the landing was committed at yield, so the restart still knows about it (B3)',
  );
  assert.equal(uncertain.length, 1, 'the OUTCOME is unknown; the LANDING is not');
  assertLiveEqualsReplayed(k2, k2.familyFor(exec).familyId);
});

// ---------------------------------------------------------------------------
// E5–E7: suspension and resume
// ---------------------------------------------------------------------------

test('B3/E5: a suspended invocation can be resumed, and releases its lease when it settles', async () => {
  const world = new World();
  const f = setup(world, { skipOnResume: true });

  const usdBefore = f.k.remainingFor(f.exec, f.grant.id, 'usd');
  const out = await f.k.invoke(f.exec, 'pay.card', { after: 'suspend' }, f.grant, { step: 'charge' });
  assert.equal(out.state, 'suspended');

  // While suspended the lease is still held: the effect key is occupied and the budget
  // is reserved. Suspension is a pause, not an ending.
  assert.ok(
    f.k.remainingFor(f.exec, f.grant.id, 'usd') < usdBefore,
    'a suspended invocation still holds its reservation',
  );

  const resumed = await f.k.resume(f.exec, out.invocationId, { approved: true });
  assert.equal(resumed.state, 'completed');
  assert.equal(world.count('charge'), 1, 'a well-behaved capability does not repeat work on re-entry');

  const ledger = f.k.familyFor(f.exec).grants.get(f.grant.id)!;
  assert.equal(ledger.reserved['usd'] ?? 0, 0, 'the lease is released once the invocation ends');
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B3/E6: a suspended invocation survives restart and is resumable from the journal alone', async () => {
  const world = new World();
  const storage = new Storage();
  const k1 = new S1Kernel(storage);
  k1.register(payer(world, { skipOnResume: true }));
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, { rights: ['pay'], limits: { invocations: 50, usd: 500 } });
  const out = await k1.invoke(exec, 'pay.card', { after: 'suspend' }, grant, { step: 'charge' });
  assert.equal(out.state, 'suspended');

  // Nothing but the journal crosses the restart — no generator, no closure, no memory.
  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [payer(world, { skipOnResume: true })]);
  assert.equal(uncertain.length, 0, 'suspension is a deliberate state, not an unknown outcome');

  const inv = k2.familyFor(exec).executions.get(exec)!.invocations.get(out.invocationId)!;
  assert.equal(inv.state, 'suspended');
  assert.deepEqual(inv.suspension?.payload, { ref: 'appr-1' });

  const resumed = await k2.resume(exec, out.invocationId, { approved: true });
  assert.equal(resumed.state, 'completed');
  assert.equal(world.count('charge'), 1);
  assertLiveEqualsReplayed(k2, k2.familyFor(exec).familyId);
});

test('B3/E7: a capability that repeats a landing on resume is contained, not obeyed', async () => {
  // The honest boundary. A capability re-entered after suspension re-runs its body; if it
  // ignores `ctx.resume` it may call the real API a second time, and no kernel that does
  // not sit between the capability and the network can stop that. What the kernel
  // guarantees is that its own records stay coherent: the second yield is recorded as a
  // duplicate, the ledger keeps exactly one landing, and protection is unaffected.
  const world = new World();
  const f = setup(world, { skipOnResume: false });   // deliberately badly behaved

  const out = await f.k.invoke(f.exec, 'pay.card', { after: 'suspend' }, f.grant, { step: 'charge' });
  const resumed = await f.k.resume(f.exec, out.invocationId, { approved: true });
  assert.equal(resumed.state, 'completed');

  // The world really was touched twice — the kernel could not prevent it, and the test
  // says so rather than implying otherwise.
  assert.equal(world.count('charge'), 2, 'documented limit: re-entry is a capability-contract obligation');

  // What the kernel DID keep true:
  const fam = f.k.familyFor(f.exec);
  const key = keyFor({ after: 'suspend' });
  assert.equal(fam.landed.filter((l) => l.effectKey === key).length, 1, 'exactly one landing in the ledger');
  const dups = f.k.events(f.familyId).filter(
    (e) => e.kind === 'effect.deduplicated' && e.payload['reason'] === 're-yielded-after-resume',
  );
  assert.equal(dups.length, 1, 'the repeat is recorded, not silently swallowed');
  assertLiveEqualsReplayed(f.k, f.familyId);
});

test('B3/E8: resume is refused for anything that is not suspended', async () => {
  const world = new World();
  const f = setup(world);
  const out = await f.k.invoke(f.exec, 'pay.card', { after: 'ok' }, f.grant, { step: 'charge' });
  assert.equal(out.state, 'completed');

  await assert.rejects(
    () => f.k.resume(f.exec, out.invocationId, {}),
    (e: unknown) => e instanceof S1Error && /not suspended/.test(e.message),
    'a completed invocation must not be re-entered: its lease is gone and its effect settled',
  );
  await assert.rejects(
    () => f.k.resume(f.exec, 'inv_nonexistent' as never, {}),
    (e: unknown) => e instanceof S1Error,
  );
});

test('B3/E12: a misdeclared landing is recorded at the strictest class, never discarded', async () => {
  // Two findings, in sequence, and the second corrects the first.
  //
  // F-19 (differential testing): a capability declaring class `local` yielded
  // {type: 'external', landed: true}. The kernel recorded a landing, but protection keys
  // off the declared CLASS — and `local` is not exclusive — so the landing bound nothing
  // and the effect could be repeated freely.
  //
  // F-22 (adversarial review): the fix for F-19 REFUSED the landing and recorded only a
  // policy denial. That was worse than the bug. The original bug recorded a true fact and
  // failed to act on it; the fix destroyed the fact, so `hasLanded` was false, protection
  // never engaged, and the next attempt hit the world again — a double charge produced by
  // a safety fix.
  //
  // A report that the world changed is never discarded. The landing is recorded at the
  // strictest class so protection engages, and the misdeclaration is journaled beside it.
  // Punishing a bad manifest by forgetting what it told us is not a safety measure.
  const world = new World();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register({
    manifest: {
      id: 'liar', version: '1.0.0',
      traits: {
        effectClass: 'local', probeable: false, compensatable: false, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'liar.op', fields: ['n'] },
    },
    async *invoke(): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      world.apply('charge');
      yield { type: 'external', descriptor: 'charge', landed: true };
      return { status: 'ok', output: {} };
    },
  });
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const grant = k.issueGrant(exec, { rights: ['x'], limits: { invocations: 10 } });

  const out = await k.invoke(exec, 'liar', { n: 1 }, grant, { step: 'op' });
  assert.equal(out.state, 'completed');

  const fam = k.familyFor(exec);
  assert.equal(fam.landed.length, 1, 'the world-fact is kept');
  assert.equal(
    fam.landed[0]!.effectClass, 'external-irreversible',
    'recorded at the strictest class, so protection engages despite the bad manifest',
  );

  const key = resolveEffectIdentity({ capabilityId: 'liar', effectClass: 'local', request: { n: 1 }, schema: { operation: 'liar.op', fields: ['n'] } }).key as EffectKey;
  assert.equal(k.isProtected(exec, key), true);
  await assert.rejects(
    () => k.invoke(exec, 'liar', { n: 1 }, grant, { step: 'op' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'and the repeat that the first fix permitted is refused',
  );
  assert.equal(world.count('charge'), 1, 'the world is touched once');

  const denials = k.events(familyId).filter(
    (e) => e.kind === 'policy.denied' && e.payload['reason'] === 'external-landing-from-non-external-class',
  );
  assert.equal(denials.length, 1, 'the misdeclaration is journaled beside the landing');
  assert.equal(denials[0]!.payload['declaredClass'], 'local');
  assert.equal(denials[0]!.payload['recordedAs'], 'external-irreversible');
  assertLiveEqualsReplayed(k, familyId);
});

// ---------------------------------------------------------------------------
// E9–E11: uncertainty dispositions
// ---------------------------------------------------------------------------

async function crashAfterLanding(world: World): Promise<{
  k: S1Kernel; exec: ReturnType<S1Kernel['createExecution']>; invocationId: never;
}> {
  const storage = new Storage();
  const cap = payer(world);
  const k1 = new S1Kernel(storage);
  k1.register(cap);
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, { rights: ['pay'], limits: { invocations: 50, usd: 500 } });
  storage.armCrash(5, { label: 'settle' });
  await assert.rejects(
    () => k1.invoke(exec, 'pay.card', { after: 'ok' }, grant, { step: 'charge' }),
    (e: unknown) => e instanceof CrashError,
  );
  storage.disarm();
  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [cap]);
  return { k: k2, exec, invocationId: uncertain[0]! as never };
}

test('B3/E9: probe resolves an uncertain outcome from the provider', async () => {
  const world = new World();
  const { k, exec, invocationId } = await crashAfterLanding(world);

  const state = await k.resolveUncertainty(exec, invocationId, { kind: 'probe' });
  assert.equal(state, 'completed', 'the fixture probe reports the charge landed');
  assert.equal(k.isProtected(exec, keyFor({ after: 'ok' })), true);
  assertLiveEqualsReplayed(k, k.familyFor(exec).familyId);
});

test('B3/E10: compensate is the route for undoing a landed effect', async () => {
  const world = new World();
  const { k, exec, invocationId } = await crashAfterLanding(world);

  const state = await k.resolveUncertainty(exec, invocationId, { kind: 'compensate' });
  assert.equal(state, 'failed', 'the invocation failed; the world was put back');
  assert.equal(world.count('refund'), 1, 'compensation is a real effect, not a bookkeeping edit');

  // Protection is retained: something did happen to the world, and a fork must not repeat
  // the original just because it was compensated.
  assert.equal(k.isProtected(exec, keyFor({ after: 'ok' })), true);
  assertLiveEqualsReplayed(k, k.familyFor(exec).familyId);
});

test('B3/E11: an unresolved uncertainty stays uncertain and keeps blocking', async () => {
  const world = new World();
  const { k, exec, invocationId } = await crashAfterLanding(world);

  const fam = k.familyFor(exec);
  assert.equal(fam.executions.get(exec)!.invocations.get(invocationId)!.state, 'uncertain');
  assert.equal(fam.claims.get(keyFor({ after: 'ok' }))!.state, 'uncertain');

  // I15: uncertainty is represented, never guessed. The kernel does not quietly decide.
  const grant2 = k.rehydrateGrant(exec, [...fam.grants.keys()][0]!);
  await assert.rejects(
    () => k.invoke(exec, 'pay.card', { after: 'ok' }, grant2, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(world.count('charge'), 1);
});
