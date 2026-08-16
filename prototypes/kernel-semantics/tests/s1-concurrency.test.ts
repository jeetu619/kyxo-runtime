/**
 * B1 — deterministic concurrency: admission-time effect claims.
 *
 * The claim under test: for an effect class that requires exclusivity, no amount of
 * concurrency can cause more than one dispatch to the world.
 *
 * WHAT MAKES THESE TESTS DETERMINISTIC (no sleeps, no timing luck):
 *
 *   R1  Same-tick burst — N invocations start in one synchronous turn. Deterministic
 *       because admission runs entirely before `invoke` first suspends.
 *   R2  Mid-flight arrival — the incumbent parks inside its generator on an explicit
 *       barrier, and competitors run while it is provably parked. Deterministic because
 *       the fixture signals arrival at the barrier; the test never guesses.
 *   R3  Forced interleave — a competitor is driven INTO the incumbent's admission
 *       region through `raceHook`, i.e. the exact interleaving a broken critical
 *       section would allow. Deterministic because the test controls the schedule.
 *   R4  Static guard — the admission region's source is asserted to contain no `await`.
 *   R5  Post-crash race — competitors arrive after a crash left the claim in doubt.
 *
 * WHAT THESE TESTS DO NOT PROVE: multi-writer (multi-process) exclusivity. The kernel's
 * stated contract is one writer per family; that boundary is asserted in R6, not hidden.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError, AdmissionReentrancyError } from '../src/s1-kernel.ts';
import { digest, foldAll } from '../src/s1-fold.ts';
import type { FamilyId, S1Event } from '../src/s1-types.ts';
import { Storage, CrashError } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectClass,
  EffectProposal, EffectKey, InvokeCtx,
} from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The world. Counts how many times each logical effect was actually applied.
 *
 * This is the only thing that matters for B1: journal bookkeeping can look perfect
 * while the world is charged twice. Every race test asserts against THIS.
 */
class World {
  readonly applied = new Map<string, number>();
  apply(descriptor: string): void {
    this.applied.set(descriptor, (this.applied.get(descriptor) ?? 0) + 1);
  }
  count(descriptor: string): number { return this.applied.get(descriptor) ?? 0; }
  total(): number { return [...this.applied.values()].reduce((a, b) => a + b, 0); }
}

/** A barrier the test controls explicitly — no timers anywhere. */
class Barrier {
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => { this.release = r; });
  private arrived!: () => void;
  /** Resolves when a capability has provably parked on the barrier. */
  readonly reached = new Promise<void>((r) => { this.arrived = r; });
  async wait(): Promise<void> { this.arrived(); await this.gate; }
  open(): void { this.release(); }
}

function makeCapability(opts: {
  id: string;
  effectClass: EffectClass;
  world: World;
  barrier?: Barrier;
  descriptor?: string;
}): CapabilityProvider {
  const descriptor = opts.descriptor ?? `${opts.id}:effect`;
  return {
    manifest: {
      id: opts.id,
      version: '1.0.0',
      traits: {
        effectClass: opts.effectClass, probeable: true, compensatable: false,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'payments.charge', fields: ['amount','to'] },
    },
    async *invoke(_ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      if (opts.barrier !== undefined) await opts.barrier.wait();
      // Touch the world, THEN tell the kernel. This ordering is what makes the test
      // meaningful: if two invocations get this far, the world is already double-applied
      // and no journal record can undo it.
      opts.world.apply(descriptor);
      yield { type: 'external', descriptor, landed: true };
      return { status: 'ok', output: { ok: true } };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'unknown'; },
  };
}

interface Fixture {
  k: S1Kernel;
  storage: Storage;
  world: World;
  exec: ReturnType<S1Kernel['createExecution']>;
  grant: ReturnType<S1Kernel['issueGrant']>;
}

function setup(effectClass: EffectClass, barrier?: Barrier, capId = 'pay.card'): Fixture {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  const world = new World();
  k.register(makeCapability({ id: capId, effectClass, world, ...(barrier ? { barrier } : {}) }));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, {
    rights: ['pay'],
    limits: { invocations: 500, spawnDepth: 0, usd: 100_000 },
  });
  return { k, storage, world, exec, grant };
}

function eventsOf(k: S1Kernel, familyId: FamilyId): S1Event[] { return k.events(familyId); }
function countKind(events: readonly S1Event[], kind: string): number {
  return events.filter((e) => e.kind === kind).length;
}

/** B4/S1-I3: replaying the journal must reproduce live state exactly. */
function assertLiveEqualsReplayed(k: S1Kernel, familyId: FamilyId): void {
  const live = digest(k.family(familyId));
  const replayed = digest(foldAll(familyId, eventsOf(k, familyId)));
  assert.equal(replayed, live, 'replayed state diverged from live state (B4 / S1-I3)');
}

// ---------------------------------------------------------------------------
// R1 — same-tick burst at 2, 5, 20, 100
// ---------------------------------------------------------------------------

for (const N of [2, 5, 20, 100]) {
  test(`B1/R1: ${N} same-tick invocations of one irreversible effect produce exactly one dispatch`, async () => {
    const f = setup('external-irreversible');
    const familyId = f.k.familyFor(f.exec).familyId;

    // All N start in ONE synchronous turn: no await between them.
    const results = await Promise.allSettled(
      Array.from({ length: N }, () =>
        f.k.invoke(f.exec, 'pay.card', { amount: 10, to: 'acct-1' }, f.grant, { step: 'charge' })),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const denied = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ClaimDeniedError,
    );

    // The world is the real assertion.
    assert.equal(f.world.count('pay.card:effect'), 1, `world applied ${f.world.count('pay.card:effect')} times, expected exactly 1`);
    assert.equal(f.world.total(), 1);

    assert.equal(fulfilled.length, 1, 'exactly one invocation may succeed');
    assert.equal(denied.length, N - 1, 'every loser must be denied at admission, not silently dropped');
    assert.equal((fulfilled[0] as PromiseFulfilledResult<{ state: string }>).value.state, 'completed');

    // The journal must tell the same story: one claim, one dispatch, one landing.
    const ev = eventsOf(f.k, familyId);
    assert.equal(countKind(ev, 'effect.claimed'), 1);
    assert.equal(countKind(ev, 'invocation.dispatched'), 1);
    assert.equal(countKind(ev, 'effect.landed'), 1);
    assert.equal(countKind(ev, 'effect.claim.denied'), N - 1);

    // Losers are journaled, not invisible (I14: refusals are records).
    for (const e of ev.filter((x) => x.kind === 'effect.claim.denied')) {
      assert.equal(e.payload['reason'], 'claim-held');
    }

    assertLiveEqualsReplayed(f.k, familyId);
  });
}

// ---------------------------------------------------------------------------
// R2 — competitors arrive while the incumbent is provably mid-flight
// ---------------------------------------------------------------------------

for (const N of [2, 5, 20, 100]) {
  test(`B1/R2: ${N - 1} competitors arriving mid-flight cannot join a held claim`, async () => {
    const barrier = new Barrier();
    const f = setup('external-irreversible', barrier);
    const familyId = f.k.familyFor(f.exec).familyId;

    const incumbent = f.k.invoke(f.exec, 'pay.card', { amount: 10 }, f.grant, { step: 'charge' });
    // Deterministic: proceed only once the capability has provably parked on the barrier.
    // At this point the claim is committed and the world has NOT yet been touched.
    await barrier.reached;
    assert.equal(f.world.total(), 0, 'incumbent should be parked before touching the world');

    const competitors = await Promise.allSettled(
      Array.from({ length: N - 1 }, () =>
        f.k.invoke(f.exec, 'pay.card', { amount: 10 }, f.grant, { step: 'charge' })),
    );
    assert.ok(
      competitors.every((r) => r.status === 'rejected' && r.reason instanceof ClaimDeniedError),
      'a held claim must reject every mid-flight competitor',
    );

    barrier.open();
    const out = await incumbent;
    assert.equal(out.state, 'completed');
    assert.equal(f.world.count('pay.card:effect'), 1);

    const ev = eventsOf(f.k, familyId);
    assert.equal(countKind(ev, 'effect.landed'), 1);
    assert.equal(countKind(ev, 'effect.claim.denied'), N - 1);
    assertLiveEqualsReplayed(f.k, familyId);
  });
}

// ---------------------------------------------------------------------------
// R3 — forced interleave INSIDE the admission region
// ---------------------------------------------------------------------------

test('B1/R3: a competitor forced into the middle of admission is refused, not admitted', async () => {
  const f = setup('external-irreversible');
  const familyId = f.k.familyFor(f.exec).familyId;

  // This is the interleaving a broken critical section would permit: the incumbent has
  // checked the claim table and found it free, and a competitor now runs its ENTIRE
  // admission before the incumbent commits its claim. Real in-process concurrency cannot
  // produce this — the region is synchronous — so we manufacture it.
  // NOTE: `invoke` is async, so a synchronous throw inside it surfaces as a REJECTED
  // PROMISE, never as a thrown exception at the call site. Capturing it with try/catch
  // silently observes nothing (first draft of this test did exactly that and reported a
  // clean pass while an unhandled rejection escaped).
  let racedOutcome: Promise<unknown> | null = null;
  let fired = 0;
  f.k.raceHook = () => {
    fired += 1;
    if (fired > 1) return;                       // only race the first admission
    racedOutcome = f.k
      .invoke(f.exec, 'pay.card', { amount: 10 }, f.grant, { step: 'charge' })
      .then((v) => v as unknown, (e: unknown) => e);
  };

  const out = await f.k.invoke(f.exec, 'pay.card', { amount: 10 }, f.grant, { step: 'charge' });
  f.k.raceHook = null;
  const raced: unknown = racedOutcome === null ? null : await racedOutcome;
  assert.equal(fired, 1, 'the race hook must have fired exactly once');

  assert.equal(out.state, 'completed');
  // THE point of this test: the world was touched once, even under an interleaving that
  // the design says is impossible.
  assert.equal(f.world.count('pay.card:effect'), 1);

  // And it is refused for the RIGHT reason. If this assertion ever changes to some other
  // error, the atomicity argument has moved and docs/25 must move with it.
  assert.ok(
    raced instanceof AdmissionReentrancyError,
    `expected AdmissionReentrancyError, got ${String(raced)}`,
  );

  const ev = eventsOf(f.k, familyId);
  assert.equal(countKind(ev, 'effect.claimed'), 1);
  assert.equal(countKind(ev, 'invocation.dispatched'), 1);
  assertLiveEqualsReplayed(f.k, familyId);
});

// ---------------------------------------------------------------------------
// R4 — the atomicity contract, mechanized
// ---------------------------------------------------------------------------

test('B1/R4: the admission critical section contains no await (static guard)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/s1-kernel.ts', import.meta.url), 'utf8');

  const start = src.indexOf('// ---------------- ADMISSION:');
  const end = src.indexOf('// ---------------- END synchronous admission region');
  assert.ok(start > 0 && end > start, 'admission region markers must exist in s1-kernel.ts');

  const region = src.slice(start, end);
  // Strip comments so prose about `await` does not trip the guard.
  const code = region
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  for (const forbidden of [/\bawait\b/, /\.then\s*\(/, /\byield\b/]) {
    assert.ok(
      !forbidden.test(code),
      `admission region must stay synchronous; found ${String(forbidden)}. ` +
      'Adding a suspension point here reopens the check-then-claim race that B1 closed.',
    );
  }
});

// ---------------------------------------------------------------------------
// R5 — racing after a crash left the claim in doubt
// ---------------------------------------------------------------------------

test('B1/R5: after a crash mid-dispatch, competitors are blocked by the uncertain claim', async () => {
  const storage = new Storage();
  const world = new World();
  const cap = makeCapability({ id: 'pay.card', effectClass: 'external-irreversible', world });

  const k1 = new S1Kernel(storage);
  k1.register(cap);
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, { rights: ['pay'], limits: { invocations: 50, usd: 1000 } });

  // Writes so far: execution.created (1), grant.issued (2). The admission commit is 3;
  // crash on write 4, which is the `effect.landed` commit — after the world was touched.
  storage.armCrash(4, { label: 'effect.landed' });
  await assert.rejects(
    () => k1.invoke(exec, 'pay.card', { amount: 10 }, grant, { step: 'charge' }),
    (e: unknown) => e instanceof CrashError,
  );
  assert.equal(world.count('pay.card:effect'), 1, 'the world was touched before the crash');
  storage.disarm();

  // Restart from the durable journal alone.
  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [cap]);
  assert.equal(uncertain.length, 1, 'a dispatched invocation with no outcome must become uncertain');

  const familyId = k2.familyFor(exec).familyId;
  const grant2 = k2.rehydrateGrant(exec, grant.id);

  const competitors = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      k2.invoke(exec, 'pay.card', { amount: 10 }, grant2, { step: 'charge' })),
  );
  assert.ok(
    competitors.every((r) => r.status === 'rejected' && r.reason instanceof ClaimDeniedError),
    'an uncertain claim must block re-dispatch (I15): the outcome is unknown, not absent',
  );
  // The crash must not have licensed a second charge.
  assert.equal(world.count('pay.card:effect'), 1);

  const ev = eventsOf(k2, familyId);
  for (const e of ev.filter((x) => x.kind === 'effect.claim.denied')) {
    assert.equal(e.payload['reason'], 'claim-uncertain');
  }
  assertLiveEqualsReplayed(k2, familyId);
});

// ---------------------------------------------------------------------------
// R6 — the boundary of the claim: what exclusivity does NOT cover
// ---------------------------------------------------------------------------

test('B1/R6: non-exclusive classes may double-dispatch concurrently — stated, not hidden', async () => {
  // `external-idempotent` declares that repeating under one effect key is safe, so the
  // kernel does not serialize it. Sequential duplicates dedup on the terminal outcome;
  // CONCURRENT duplicates have no terminal outcome to dedup against yet, so both run.
  //
  // This is a deliberate limit of the S1 record format, not an oversight, and it is
  // asserted here so a future change cannot quietly alter it. Recorded in docs/25 as a
  // known semantic gap (in-flight dedup for non-exclusive classes).
  const f = setup('external-idempotent');
  const familyId = f.k.familyFor(f.exec).familyId;

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      f.k.invoke(f.exec, 'pay.card', { amount: 1 }, f.grant, { step: 'read' })),
  );
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  assert.equal(f.world.count('pay.card:effect'), 5, 'idempotent effects are not serialized');

  // Sequential duplicates, by contrast, DO dedup against the terminal outcome.
  const after = await f.k.invoke(f.exec, 'pay.card', { amount: 1 }, f.grant, { step: 'read' });
  assert.equal(after.deduplicated, true);
  assert.equal(f.world.count('pay.card:effect'), 5, 'no sixth application');

  assertLiveEqualsReplayed(f.k, familyId);
});

test('B1/R6b: effect identity is derived from the request, so different requests never collide', async () => {
  const f = setup('external-irreversible');
  const familyId = f.k.familyFor(f.exec).familyId;

  const a = await f.k.invoke(f.exec, 'pay.card', { amount: 10 }, f.grant, { step: 'charge' });
  const b = await f.k.invoke(f.exec, 'pay.card', { amount: 11 }, f.grant, { step: 'charge' });
  assert.equal(a.state, 'completed');
  assert.equal(b.state, 'completed');
  // Two genuinely different charges must both be allowed to land.
  assert.equal(f.world.count('pay.card:effect'), 2);

  // But the same request twice is protected, even sequentially and even after settling.
  await assert.rejects(
    () => f.k.invoke(f.exec, 'pay.card', { amount: 10 }, f.grant, { step: 'charge' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(f.world.count('pay.card:effect'), 2);
  assertLiveEqualsReplayed(f.k, familyId);
});
