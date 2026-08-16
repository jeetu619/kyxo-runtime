/**
 * Attacks on the S1 record format and authority model.
 *
 * The threat model these tests assume: CAPABILITY CODE IS UNTRUSTED. It runs in-process,
 * it can read whatever it is handed, and it may be actively hostile. Everything the kernel
 * guarantees must survive that, and where it cannot, the test says so out loud instead of
 * arranging for the attack not to be attempted.
 *
 * Each test names the attack, then asserts what the kernel does about it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, AuthorizationError, ClaimDeniedError, S1Error, verifyS1Record } from '../src/s1-kernel.ts';
import { assertS1Invariants } from '../src/s1-invariants.ts';
import { digest, foldAll } from '../src/s1-fold.ts';
import type { FamilyId } from '../src/s1-types.ts';
import { resolveEffectIdentity } from '../src/s1b-identity.ts';
import { Storage, sha } from '../src/storage.ts';
import { GrantHandle } from '../src/types.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectProposal, InvokeCtx,
} from '../src/types.ts';

class World {
  readonly calls: string[] = [];
  apply(d: string): void { this.calls.push(d); }
  count(d: string): number { return this.calls.filter((c) => c === d).length; }
}

/** Whatever the request tells it to do. The attacker's instrument. */
function hostile(world: World, id = 'hostile'): CapabilityProvider {
  return {
    manifest: {
      id, version: '1.0.0',
      traits: {
        effectClass: 'external-irreversible', probeable: false, compensatable: false,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: `hostile.op.${id}`, fields: ['land','spam','delegate','usage','n'] },
      units: { usd: { perInvocation: 1, metered: true } },
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      const req = ctx.request as {
        land?: boolean; spam?: number; delegate?: string;
        usage?: Record<string, number>;
      };
      if (req.land === true) {
        world.apply('charge');
        yield { type: 'external', descriptor: 'charge', landed: true };
      }
      for (let i = 0; i < (req.spam ?? 0); i += 1) {
        world.apply('charge');
        yield { type: 'external', descriptor: `charge-${String(i)}`, landed: true };
      }
      if (req.usage !== undefined) yield { type: 'usage', units: req.usage };
      if (req.delegate !== undefined) {
        yield { type: 'delegate', capabilityId: req.delegate, request: { land: true }, step: 'sub' };
      }
      return { status: 'ok', output: { done: true } };
    },
  };
}

function setup(world: World, limits: Record<string, number> = { invocations: 20, usd: 10 }): {
  k: S1Kernel; storage: Storage; exec: ReturnType<S1Kernel['createExecution']>;
  grant: ReturnType<S1Kernel['issueGrant']>; familyId: FamilyId;
} {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(hostile(world));
  k.register(hostile(world, 'other'));
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, { rights: ['pay'], limits });
  return { k, storage, exec, grant, familyId: k.familyFor(exec).familyId };
}

function check(k: S1Kernel, familyId: FamilyId): void {
  assertS1Invariants(k.family(familyId), { events: k.events(familyId) });
  assert.equal(digest(foldAll(familyId, k.events(familyId))), digest(k.family(familyId)));
}

// ---------------------------------------------------------------------------
// A1–A3 — forging authority
// ---------------------------------------------------------------------------

test('attack A1: forging a grant handle by every route JavaScript offers', async () => {
  const world = new World();
  const f = setup(world);
  const real = f.grant;

  const forgeries: { name: string; handle: GrantHandle }[] = [
    { name: 'new GrantHandle with a real id', handle: new GrantHandle(real.id) },
    { name: 'Object.create on the prototype', handle: Object.assign(
      Object.create(Object.getPrototypeOf(real) as object) as GrantHandle, { id: real.id }) },
    { name: 'structural clone', handle: { ...real } as GrantHandle },
    { name: 'plain object with the right shape', handle: { id: real.id } as GrantHandle },
    { name: 'JSON round trip', handle: JSON.parse(JSON.stringify(real)) as GrantHandle },
  ];

  for (const { name, handle } of forgeries) {
    await assert.rejects(
      () => f.k.invoke(f.exec, 'hostile', { land: true }, handle, { step: 'x' }),
      (e: unknown) => e instanceof AuthorizationError,
      `forgery accepted: ${name}`,
    );
  }
  assert.equal(world.count('charge'), 0, 'no forged handle may reach the world');
  check(f.k, f.familyId);
});

test('attack A2: reading a grant id out of the journal confers nothing', async () => {
  // Grant ids are in plain sight in every event. Authority is object identity in the
  // kernel's private registry, so seeing an id is not the same as holding one.
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'hostile', { land: true }, f.grant, { step: 'a' });

  const idFromJournal = f.k.events(f.familyId).find((e) => e.grantId !== undefined)!.grantId!;
  assert.equal(idFromJournal, f.grant.id, 'the id really is readable');

  await assert.rejects(
    () => f.k.invoke(f.exec, 'hostile', { land: true }, new GrantHandle(idFromJournal), { step: 'b' }),
    (e: unknown) => e instanceof AuthorizationError,
  );
  check(f.k, f.familyId);
});

test('attack A3: a grant from another family cannot be used here', async () => {
  const world = new World();
  const a = setup(world);
  const storage2 = new Storage();
  const k2 = new S1Kernel(storage2);
  k2.register(hostile(world));
  const exec2 = k2.createExecution();
  const grant2 = k2.issueGrant(exec2, { rights: ['pay'], limits: { invocations: 20, usd: 10 } });

  // A genuine, kernel-minted handle — for a different kernel and a different family.
  await assert.rejects(
    () => a.k.invoke(a.exec, 'hostile', { land: true }, grant2, { step: 'x' }),
    (e: unknown) => e instanceof AuthorizationError,
    'authority is scoped to the family that issued it',
  );
});

// ---------------------------------------------------------------------------
// A4–A6 — attacking the effect ledger
// ---------------------------------------------------------------------------

test('attack A4: a capability cannot choose or vary its own effect identity', async () => {
  // Effect identity is derived by the kernel from (capability id, step, canonical request).
  // The capability contributes nothing to it and cannot see the derivation, so it cannot
  // arrange for two different effects to share a key or one effect to occupy two.
  const world = new World();
  const f = setup(world);

  const key = resolveEffectIdentity({ capabilityId: 'hostile', effectClass: 'external-irreversible', request: { land: true }, schema: { operation: 'hostile.op.hostile', fields: ['land','spam','delegate','usage','n'] } }).key;
  await f.k.invoke(f.exec, 'hostile', { land: true }, f.grant, { step: 'a' });
  assert.equal(f.k.isProtected(f.exec, key as never), true, 'the kernel derived exactly this key');

  // Same capability, same step, same request ⇒ same key ⇒ refused, whatever it wants.
  await assert.rejects(
    () => f.k.invoke(f.exec, 'hostile', { land: true }, f.grant, { step: 'a' }),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  // A different capability with an identical request gets a DIFFERENT key: identity
  // includes the capability, so one cannot squat on another's effects.
  const out = await f.k.invoke(f.exec, 'other', { land: true }, f.grant, { step: 'a' });
  assert.equal(out.state, 'completed');
  assert.equal(world.count('charge'), 2, 'two genuinely different effects');
  check(f.k, f.familyId);
});

test('attack A5: yielding many landings does not multiply the ledger', async () => {
  // A capability that touches the world repeatedly inside one invocation is really
  // touching the world repeatedly — the kernel cannot prevent that. What it must not do
  // is record several landings for one key, which would corrupt the ledger.
  const world = new World();
  const f = setup(world);

  await f.k.invoke(f.exec, 'hostile', { spam: 5 }, f.grant, { step: 'a' });
  assert.equal(world.count('charge'), 5, 'the calls really happened — stated, not hidden');

  const fam = f.k.familyFor(f.exec);
  const key = resolveEffectIdentity({ capabilityId: 'hostile', effectClass: 'external-irreversible', request: { spam: 5 }, schema: { operation: 'hostile.op.hostile', fields: ['land','spam','delegate','usage','n'] } }).key;
  assert.equal(
    fam.landed.filter((l) => l.effectKey === key).length, 1,
    'one effect key, one landing: the ledger stays coherent under abuse',
  );
  check(f.k, f.familyId);
});

test('attack A6: a capability cannot settle more than the kernel reserved for it', async () => {
  const world = new World();
  const f = setup(world, { invocations: 20, usd: 10 });

  await f.k.invoke(f.exec, 'hostile', { usage: { usd: 1_000_000 } }, f.grant, { step: 'a', estimate: { usd: 2 } });
  const ledger = f.k.familyFor(f.exec).grants.get(f.grant.id)!;
  assert.equal(ledger.settled['usd'], 2, 'settlement is capped at the reservation');
  assert.ok(f.k.remainingFor(f.exec, f.grant.id, 'usd') >= 0);

  const denials = f.k.events(f.familyId).filter(
    (e) => e.kind === 'policy.denied' && e.payload['reason'] === 'usage-exceeds-reservation',
  );
  assert.equal(denials.length, 1, 'the attempt is recorded');
  check(f.k, f.familyId);
});

// ---------------------------------------------------------------------------
// A7–A8 — attacking through delegation
// ---------------------------------------------------------------------------

test('attack A7: delegation cannot widen authority', async () => {
  const world = new World();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(hostile(world));
  k.register(hostile(world, 'other'));
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  // spawnDepth 1 permits exactly one level of delegation.
  const grant = k.issueGrant(exec, { rights: ['pay'], limits: { invocations: 20, usd: 10, spawnDepth: 1 } });

  await k.invoke(exec, 'hostile', { delegate: 'other' }, grant, { step: 'a' });

  const fam = k.familyFor(exec);
  const child = [...fam.grants.values()].find((g) => g.parent === grant.id);
  assert.ok(child !== undefined, 'delegation minted a child grant');
  for (const r of child.rights) {
    assert.ok(fam.grants.get(grant.id)!.rights.includes(r), `child gained right ${r}`);
  }
  check(k, familyId);
});

test('attack A8: delegation cannot exceed the permitted depth', async () => {
  const world = new World();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(hostile(world));
  k.register(hostile(world, 'other'));
  const exec = k.createExecution();
  const familyId = k.familyFor(exec).familyId;
  // spawnDepth 0: no delegation at all.
  const grant = k.issueGrant(exec, { rights: ['pay'], limits: { invocations: 20, usd: 10, spawnDepth: 0 } });

  await k.invoke(exec, 'hostile', { delegate: 'other' }, grant, { step: 'a' });
  const denials = k.events(familyId).filter(
    (e) => e.kind === 'policy.denied' && e.payload['reason'] === 'spawn-depth-exceeded',
  );
  assert.equal(denials.length, 1, 'the refusal is journaled');
  assert.equal(world.count('charge'), 0, 'the delegate never ran');
  check(k, familyId);
});

// ---------------------------------------------------------------------------
// A9–A11 — attacking the journal
// ---------------------------------------------------------------------------

test('attack A9: replaying a genuine commit record is detected', async () => {
  // The record is authentic — it was written by the kernel and its checksum verifies. The
  // attack is duplication, not forgery, and it is caught by the chain rather than by the
  // checksum: the replayed copy reuses a sequence number and a prev link.
  const world = new World();
  const f = setup(world);
  await f.k.invoke(f.exec, 'hostile', { land: true }, f.grant, { step: 'a' });

  const { records } = f.storage.readJournal(verifyS1Record);
  const replayed = records[records.length - 1];
  assert.equal(verifyS1Record(replayed), true, 'the record is genuine');

  // Append the duplicate and read the journal back as recovery would.
  f.storage.appendCommit(replayed);
  const all = f.storage.readJournal(verifyS1Record).records as { familyId: FamilyId; events: never[] }[];
  const events = all.filter((r) => r.familyId === f.familyId).flatMap((r) => r.events);

  assert.throws(
    () => assertS1Invariants(foldAll(f.familyId, events), { events }),
    /S1-I8|S1-I9/,
    'a duplicated record must violate sequence density or the chain',
  );
});

test('attack A10: a capability cannot reach the kernel through its context', async () => {
  // The structural rule: InvokeCtx carries DATA ONLY. If a capability could reach a
  // kernel, a journal or a grant table from its context, the commit barrier would be
  // advisory. This asserts the shape of what capabilities are handed.
  const seen: string[] = [];
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register({
    manifest: {
      id: 'inspector', version: '1.0.0',
      traits: {
        effectClass: 'pure', probeable: false, compensatable: false, resumable: true,
        streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'liar.op', fields: ['n'] },
    },
    async *invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      for (const key of Object.keys(ctx)) seen.push(key);
      for (const [key, value] of Object.entries(ctx)) {
        // Nothing handed to a capability may be an object with kernel-ish powers.
        if (typeof value === 'object' && value !== null && key !== 'request' && key !== 'resume') {
          throw new Error(`context exposed an object at ${key}`);
        }
      }
      return { status: 'ok', output: {} };
    },
  });
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, { rights: ['x'], limits: { invocations: 5 } });
  const out = await k.invoke(exec, 'inspector', { n: 1 }, grant, { step: 'a' });
  assert.equal(out.state, 'completed');

  const allowed = new Set(['invocationId', 'executionId', 'now', 'attempt', 'request', 'resume', 'cancelled']);
  for (const key of seen) {
    assert.ok(allowed.has(key), `capability context exposed an unexpected member: ${key}`);
  }
  assert.equal(seen.includes('kernel'), false);
  assert.equal(seen.includes('storage'), false);
});

test('attack A12: a capability CAN assert a landing that never happened, and it is permanent', async () => {
  // The converse of A5, and the uncomfortable one. F-19 stopped a capability claiming a
  // landing its CLASS forbids. It does not — and cannot — stop one whose class permits
  // external effects from reporting a touch that never occurred: the kernel is not on the
  // network path and has no way to check.
  //
  // The consequence is permanent, because Wave S1 deliberately closed every route back:
  // `abandon-failed` is refused when a landing exists, the fold independently refuses to
  // free a landed key, and `allowReplayOfProtected` is unimplemented. Each is individually
  // right; together they make an unfalsifiable assertion by untrusted code irreversible.
  //
  // The blast radius is bounded — a capability can only poison keys derived from its own
  // (capabilityId, step, request) — but within that radius it is a real denial of service
  // on the caller, for the life of the journal. Stated here rather than left to be
  // discovered, and asserted so that a future mechanism for reversing it has a test to turn.
  const world = new World();
  const storage = new Storage();
  const k1 = new S1Kernel(storage);
  k1.register({
    manifest: {
      id: 'liar', version: '1.0.0',
      traits: {
        effectClass: 'external-irreversible', probeable: false, compensatable: false,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'liar.op', fields: ['n'] },
    },
    async *invoke(): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      // Touches nothing. Reports a landing anyway, then fails.
      yield { type: 'external', descriptor: 'charge', landed: true };
      return { status: 'failed', error: 'never actually called anyone' };
    },
  });
  const exec = k1.createExecution();
  const familyId = k1.familyFor(exec).familyId;
  const grant = k1.issueGrant(exec, { rights: ['pay'], limits: { invocations: 20 } });

  const out = await k1.invoke(exec, 'liar', { n: 1 }, grant, { step: 'a' });
  assert.equal(out.state, 'failed');
  assert.equal(world.count('charge'), 0, 'the world was never touched');

  const key = resolveEffectIdentity({ capabilityId: 'liar', effectClass: 'external-irreversible', request: { n: 1 }, schema: { operation: 'liar.op', fields: ['n'] } }).key as never;
  assert.equal(k1.isProtected(exec, key), true, 'yet the key is protected on the capability\'s word alone');

  // Every route back is closed, by design.
  await assert.rejects(
    () => k1.invoke(exec, 'liar', { n: 1 }, grant, { step: 'a' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'retry: refused',
  );
  const child = k1.fork(exec, 1);
  await assert.rejects(
    () => k1.invoke(child, 'liar', { n: 1 }, k1.rehydrateGrant(child, grant.id), { step: 'a' }),
    (e: unknown) => e instanceof ClaimDeniedError,
    'fork: refused',
  );

  // And it survives a cold start, because it is a committed record like any other.
  const { kernel: k2 } = S1Kernel.recover(storage, []);
  assert.equal(k2.isProtected(exec, key), true, 'permanent for the life of the journal');
  check(k2, familyId);
});

test('attack A11: an operator cannot assert away a durable landing', async () => {
  // Authority over the record has limits. An operator resolves an unknown OUTCOME; they
  // do not get to overrule what the journal says happened to the world.
  const world = new World();
  const storage = new Storage();
  const cap = hostile(world);
  const k1 = new S1Kernel(storage);
  k1.register(cap);
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, { rights: ['pay'], limits: { invocations: 20, usd: 10 } });

  storage.armCrashWhen((s) => s.includes('"kind":"invocation.completed"'), { label: 'settle' });
  await assert.rejects(() => k1.invoke(exec, 'hostile', { land: true }, grant, { step: 'a' }));
  storage.disarm();

  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [cap]);
  await assert.rejects(
    () => k2.resolveUncertainty(exec, uncertain[0]!, { kind: 'abandon-failed', authority: 'operator' }),
    (e: unknown) => e instanceof S1Error && /durable landing/.test(e.message),
  );
  assert.equal(k2.isProtected(exec, resolveEffectIdentity({ capabilityId: 'hostile', effectClass: 'external-irreversible', request: { land: true }, schema: { operation: 'hostile.op.hostile', fields: ['land','spam','delegate','usage','n'] } }).key as never), true);
  check(k2, k2.familyFor(exec).familyId);
});
