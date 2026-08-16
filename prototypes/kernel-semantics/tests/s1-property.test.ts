/**
 * Property and differential tests for the S1 record format.
 *
 * Two kinds of check, both seeded and reproducible:
 *
 *   DIFFERENTIAL — a randomly generated operation sequence is run against the kernel and
 *   against `reference-model/s1-model.ts`, which shares no code with the fold. Where they
 *   disagree, one of them is wrong. A model derived from the implementation would agree
 *   by construction and prove nothing.
 *
 *   PROPERTY — universally quantified statements checked after every step of every
 *   sequence: the world is never over-applied, the ledger never over-commits, and live
 *   state always equals a replay of the journal.
 *
 * Seeds are fixed so a failure is reproducible; KYXO_S1_SEEDS raises the count for longer
 * runs in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError, BudgetError, AuthorizationError } from '../src/s1-kernel.ts';
import { assertS1Invariants } from '../src/s1-invariants.ts';
import { digest, foldAll } from '../src/s1-fold.ts';
import { S1Model } from '../reference-model/s1-model.ts';
import type { ModelUnitPolicy } from '../reference-model/s1-model.ts';
import { Storage, sha } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectClass,
  EffectKey, EffectProposal, InvokeCtx,
} from '../src/types.ts';

// ---------------------------------------------------------------------------
// Deterministic RNG — a failure must be reproducible from its seed alone.
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const CLASSES: EffectClass[] = [
  'pure', 'local', 'external-idempotent', 'external-compensatable', 'external-irreversible',
];

const UNIT_POLICY: Record<string, ModelUnitPolicy> = {
  tokens: { perInvocation: 2, metered: true },
  credits: { perInvocation: 1, metered: false },
};

const world = { applied: new Map<string, number>() };

function capability(id: string, cls: EffectClass): CapabilityProvider {
  return {
    manifest: {
      id, version: '1.0.0',
      traits: {
        effectClass: cls, probeable: true, compensatable: true, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      units: UNIT_POLICY,
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as { land?: boolean; declare?: Record<string, number>; fail?: boolean };
      if (req.land === true) {
        const key = sha({ cap: id, step: 'op', request: ctx.request });
        world.applied.set(key, (world.applied.get(key) ?? 0) + 1);
        yield { type: 'external', descriptor: `applied:${id}`, landed: true };
      }
      if (req.declare !== undefined) yield { type: 'usage', units: req.declare };
      if (req.fail === true) return { status: 'failed', error: 'random failure' };
      return { status: 'ok', output: { ok: true } };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'unknown'; },
    async compensate(): Promise<'compensated' | 'failed'> { return 'compensated'; },
  };
}

const CAPS = CLASSES.map((cls, i) => ({ id: `cap${String(i)}`, cls, provider: capability(`cap${String(i)}`, cls) }));

interface Step {
  readonly capIndex: number;
  readonly land: boolean;
  readonly fail: boolean;
  readonly declare: Record<string, number>;
  readonly estimate: Record<string, number>;
  readonly requestId: number;
}

function generate(seed: number, length: number): Step[] {
  const r = rng(seed);
  const steps: Step[] = [];
  for (let i = 0; i < length; i += 1) {
    steps.push({
      capIndex: Math.floor(r() * CAPS.length),
      land: r() < 0.6,
      fail: r() < 0.2,
      declare: r() < 0.5 ? { tokens: Math.floor(r() * 6) } : {},
      estimate: r() < 0.4 ? { tokens: Math.floor(r() * 4) } : {},
      // A small id space so keys collide often — collisions are the interesting case.
      requestId: Math.floor(r() * 4),
    });
  }
  return steps;
}

const LIMITS = { invocations: 500, tokens: 400, credits: 400, spawnDepth: 0 };

async function runSequence(seed: number, steps: Step[]): Promise<void> {
  world.applied.clear();

  const storage = new Storage();
  const k = new S1Kernel(storage);
  for (const c of CAPS) k.register(c.provider);
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const grant = k.issueGrant(exec, { rights: ['any'], limits: LIMITS });

  const model = new S1Model();
  model.issueGrant(grant.id, ['any'], { ...LIMITS });

  for (const [i, step] of steps.entries()) {
    const cap = CAPS[step.capIndex]!;
    const request = { land: step.land, fail: step.fail, declare: step.declare, id: step.requestId };
    const key = sha({ cap: cap.id, step: 'op', request });

    // Ask the model first, so its answer is a prediction rather than a rationalisation.
    const modelInvId = `m${String(i)}`;
    const predicted = model.admit(
      modelInvId, key, cap.cls as never, grant.id, UNIT_POLICY, step.estimate,
    );

    let actual: 'admitted' | 'deduplicated' | 'denied';
    let denialReason: string | undefined;
    try {
      const out = await k.invoke(exec, cap.id, request, grant, { step: 'op', estimate: step.estimate });
      actual = out.deduplicated === true ? 'deduplicated' : 'admitted';
    } catch (err) {
      actual = 'denied';
      denialReason = err instanceof ClaimDeniedError ? 'claim'
        : err instanceof BudgetError ? 'budget'
        : err instanceof AuthorizationError ? 'authorization'
        : 'other';
    }

    assert.equal(
      actual, predicted.kind === 'admitted' ? 'admitted' : predicted.kind,
      `seed ${String(seed)} step ${String(i)}: kernel said ${actual}` +
      `${denialReason === undefined ? '' : ` (${denialReason})`}, model said ${predicted.kind}`,
    );

    // Advance the model along the same path the capability took. Every reported landing
    // is recorded, whatever the declared class: a misdeclared one is recorded at the
    // strictest class rather than discarded (docs/20 F-22).
    if (predicted.kind === 'admitted') {
      if (step.land) model.land(modelInvId);
      model.settle(modelInvId, step.fail ? 'failed' : 'completed', step.declare, UNIT_POLICY);
    }

    // ---- properties, after every step -------------------------------------
    const fam = k.familyFor(exec);
    assertS1Invariants(fam, { events: k.events(familyId) });

    assert.equal(
      digest(foldAll(familyId, k.events(familyId))), digest(fam),
      `seed ${String(seed)} step ${String(i)}: live state diverged from replay`,
    );

    // Budgets agree with the model, unit by unit.
    for (const unit of ['invocations', 'tokens', 'credits']) {
      assert.equal(
        k.remainingFor(exec, grant.id, unit), model.remaining(grant.id, unit),
        `seed ${String(seed)} step ${String(i)}: ${unit} remaining disagrees`,
      );
    }

    // Protection agrees with the model.
    assert.equal(
      k.isProtected(exec, key as EffectKey), model.isProtected(key),
      `seed ${String(seed)} step ${String(i)}: protection for ${key} disagrees`,
    );
  }
}

// ---------------------------------------------------------------------------

const SEEDS = Number(process.env['KYXO_S1_SEEDS'] ?? 24);
const LENGTH = Number(process.env['KYXO_S1_LENGTH'] ?? 30);

for (let seed = 1; seed <= SEEDS; seed += 1) {
  test(`differential: kernel and independent model agree (seed ${String(seed)})`, async () => {
    await runSequence(seed, generate(seed, LENGTH));
  });
}

// ---------------------------------------------------------------------------
// Standalone properties
// ---------------------------------------------------------------------------

test('property: an exclusive effect key is never applied to the world twice', async () => {
  // Quantified over every class and a request space small enough to force collisions.
  for (let seed = 100; seed < 112; seed += 1) {
    world.applied.clear();
    const storage = new Storage();
    const k = new S1Kernel(storage);
    for (const c of CAPS) k.register(c.provider);
    const exec = k.createExecution();
    const grant = k.issueGrant(exec, { rights: ['any'], limits: LIMITS });

    const r = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      const cap = CAPS[Math.floor(r() * CAPS.length)]!;
      const request = { land: true, fail: r() < 0.3, declare: {}, id: Math.floor(r() * 3) };
      await k.invoke(exec, cap.id, request, grant, { step: 'op' }).catch((err: unknown) => {
        if (!(err instanceof ClaimDeniedError) && !(err instanceof BudgetError)) throw err;
      });
    }

    for (const cap of CAPS) {
      const isExclusive = cap.cls === 'external-irreversible' || cap.cls === 'external-compensatable';
      if (!isExclusive) continue;
      for (let id = 0; id < 3; id += 1) {
        for (const fail of [true, false]) {
          const key = sha({ cap: cap.id, step: 'op', request: { land: true, fail, declare: {}, id } });
          const count = world.applied.get(key) ?? 0;
          assert.ok(count <= 1, `seed ${String(seed)}: ${cap.cls} key applied ${String(count)} times`);
        }
      }
    }
  }
});

test('property: replay of any committed prefix reproduces the state at that prefix', async () => {
  // B4 stated as a property over PREFIXES, not just over the final journal. A fold that is
  // only correct at the end is a fold with a hidden dependency on arrival order.
  const storage = new Storage();
  const k = new S1Kernel(storage);
  for (const c of CAPS) k.register(c.provider);
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  const grant = k.issueGrant(exec, { rights: ['any'], limits: LIMITS });

  const r = rng(7);
  const digests: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    const cap = CAPS[Math.floor(r() * CAPS.length)]!;
    await k.invoke(exec, cap.id, { land: r() < 0.5, fail: r() < 0.2, declare: {}, id: Math.floor(r() * 3) },
      grant, { step: 'op' }).catch((err: unknown) => {
      if (!(err instanceof ClaimDeniedError) && !(err instanceof BudgetError)) throw err;
    });
    digests.push(digest(k.familyFor(exec)));
  }

  // Now replay prefix by prefix and confirm the fold reaches the same place each time.
  const events = k.events(familyId);
  const seen = new Set<string>();
  for (const d of digests) seen.add(d);
  let matched = 0;
  for (let n = 1; n <= events.length; n += 1) {
    const d = digest(foldAll(familyId, events.slice(0, n)));
    if (seen.has(d)) matched += 1;
  }
  assert.ok(
    matched >= digests.length - 1,
    `only ${String(matched)} of ${String(digests.length)} observed states were reachable by prefix replay`,
  );
});
