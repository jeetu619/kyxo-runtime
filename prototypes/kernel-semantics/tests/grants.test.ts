/**
 * Grants: attenuation, revocation, time-of-use validation, and the ocap discipline
 * (docs/18 I5/I18, amendment A8).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, AuthorizationError, BudgetError } from '../src/kernel.ts';
import { Storage } from '../src/storage.ts';
import { assertInvariants } from '../src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability } from '../src/capabilities.ts';
import { GrantHandle } from '../src/types.ts';
import type { GrantId } from '../src/types.ts';

function setup() {
  const storage = new Storage();
  const k = new Kernel(storage);
  const pay = new PaymentCapability();
  for (const c of ALL_CAPABILITIES) k.register(c);
  k.register(pay);
  return { k, storage, pay };
}

test('a grant handle cannot be forged: knowing the id string is not authority', async () => {
  const { k } = setup();
  const e = k.createExecution();
  const real = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 5, spawnDepth: 1 } });

  // Attack 1: construct a handle carrying the real id (read off any journal event).
  const constructed = new GrantHandle(real.id);
  await assert.rejects(
    () => k.invoke(e, 'tool.calc', { a: 1, b: 1 }, constructed, { step: 's1' }),
    (err: unknown) => err instanceof AuthorizationError,
    'constructing the class with a known id is not authority (A8)',
  );

  // Attack 2: reconstruct the object shape without calling the constructor.
  const forged = Object.create(GrantHandle.prototype) as GrantHandle;
  Object.assign(forged, { id: real.id });
  await assert.rejects(
    () => k.invoke(e, 'tool.calc', { a: 1, b: 1 }, forged, { step: 's2' }),
    (err: unknown) => err instanceof AuthorizationError,
    'shape forgery is not authority',
  );

  // Attack 3: shallow-copy a genuine handle.
  const copied = { ...real } as GrantHandle;
  await assert.rejects(
    () => k.invoke(e, 'tool.calc', { a: 1, b: 1 }, copied, { step: 's3' }),
    (err: unknown) => err instanceof AuthorizationError,
    'copying a handle does not copy authority — identity is the credential',
  );

  // The genuine handle still works.
  const ok = await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, real, { step: 's4' });
  assert.equal(ok.state, 'completed');
});

test('attenuation cannot add rights or exceed the parent remaining budget', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const parent = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 4, spawnDepth: 2 } });

  assert.throws(
    () => k.attenuate(e, parent, { rights: ['compute', 'pay'], limits: { invocations: 1, spawnDepth: 1 } }),
    (err: unknown) => err instanceof AuthorizationError,
    'a child may not gain a right the parent lacks (I18)',
  );
  assert.throws(
    () => k.attenuate(e, parent, { rights: ['compute'], limits: { invocations: 99, spawnDepth: 1 } }),
    (err: unknown) => err instanceof AuthorizationError,
    'a child may not exceed the parent budget (I5)',
  );

  const child = k.attenuate(e, parent, { rights: ['compute'], limits: { invocations: 2, spawnDepth: 1 } });
  await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, child, { step: 'c1' });
  assertInvariants({ kernel: k, storage }, 'attenuated invocation');
});

test('spend on a child grant is visible on every ancestor (lineage accounting)', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const root = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 2 } });
  const child = k.attenuate(e, root, { rights: ['compute'], limits: { invocations: 3, spawnDepth: 1 } });

  await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, child, { step: 'a' });
  await k.invoke(e, 'tool.calc', { a: 2, b: 2 }, child, { step: 'b' });

  const rootState = k.state(e).grants.get(root.id as GrantId)!;
  assert.equal(rootState.settled['invocations'], 2, 'child spend settles against the root');
  assertInvariants({ kernel: k, storage }, 'lineage accounting');
});

test('budget exhaustion denies admission before dispatch, with a journal record', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 1, spawnDepth: 1 } });

  await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, g, { step: 'one' });
  await assert.rejects(
    () => k.invoke(e, 'tool.calc', { a: 2, b: 2 }, g, { step: 'two' }),
    (err: unknown) => err instanceof BudgetError,
  );
  const denials = k.events(e).filter((x) => x.kind === 'grant.denied');
  assert.equal(denials.length, 1);
  assert.equal(denials[0]!.payload['reason'], 'budget-exhausted');
  // Nothing was dispatched for the denied attempt.
  const dispatches = k.events(e).filter((x) => x.kind === 'invocation.dispatched');
  assert.equal(dispatches.length, 1, 'denial happens before dispatch');
  assertInvariants({ kernel: k, storage }, 'budget exhaustion');
});

test('revocation is transitive and evaluated at time of use', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const root = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 2 } });
  const child = k.attenuate(e, root, { rights: ['compute'], limits: { invocations: 5, spawnDepth: 1 } });

  await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, child, { step: 'before' });
  k.revoke(e, root);

  await assert.rejects(
    () => k.invoke(e, 'tool.calc', { a: 2, b: 2 }, child, { step: 'after' }),
    (err: unknown) => err instanceof AuthorizationError,
    'revoking the parent must revoke the child transitively',
  );
  assertInvariants({ kernel: k, storage }, 'transitive revocation');
});

test('an expired grant is refused at time of use, not at issue', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 5, spawnDepth: 1 }, expiresAt: 3 });
  await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, g, { step: 'early' });
  k.tick(100);
  await assert.rejects(
    () => k.invoke(e, 'tool.calc', { a: 2, b: 2 }, g, { step: 'late' }),
    (err: unknown) => err instanceof AuthorizationError,
  );
  assertInvariants({ kernel: k, storage }, 'expiry at time of use');
});

test('a fork inherits grant state as of the cut, but a post-cut revocation still binds', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 20, spawnDepth: 1 } });
  await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, g, { step: 'pre' });
  const cp = k.checkpoint(e);

  // Authority is revoked AFTER the cut.
  k.revoke(e, g);
  const b = k.fork(cp.id, { dispositions: {} });

  await assert.rejects(
    () => k.invoke(b, 'tool.calc', { a: 7, b: 7 }, g, { step: 'in-fork' }),
    (err: unknown) => err instanceof AuthorizationError,
    'a resurrected checkpoint must not resurrect revoked authority',
  );
  assertInvariants({ kernel: k, storage }, 'fork does not resurrect revoked authority');
});

test('delegation runs under attenuated authority and cannot widen it', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 12, spawnDepth: 2 } });

  const out = await k.invoke(e, 'agent.coder', { task: 'fix' }, g, { step: 'agent' });
  assert.equal(out.state, 'completed');

  const grants = [...k.state(e).grants.values()];
  const children = grants.filter((x) => x.parent !== undefined);
  assert.ok(children.length >= 1, 'delegation minted at least one attenuated grant');
  for (const c of children) {
    const parent = grants.find((p) => p.id === c.parent)!;
    assert.ok(c.limits['spawnDepth']! < parent.limits['spawnDepth']!, 'depth strictly decreases');
    for (const r of c.rights) assert.ok(parent.rights.includes(r), 'no right is invented by delegating');
  }
  assertInvariants({ kernel: k, storage }, 'delegation attenuation');
});

test('an infinitely self-delegating capability is bounded by authority, not by hope', async () => {
  const { k, storage } = setup();
  const { recursiveCapability } = await import('../src/capabilities.ts');
  recursiveCapability.depthReached = 0;

  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 100, spawnDepth: 3 } });

  // This capability would recurse forever if the kernel let it.
  const out = await k.invoke(e, 'evil.recursive', { n: 0 }, g, { step: 'boom' });
  assert.equal(out.state, 'completed', 'the outer invocation still terminates cleanly');
  assert.ok(recursiveCapability.depthReached <= 3, `recursion stopped at depth ${recursiveCapability.depthReached}`);

  const denials = k.events(e).filter((x) => x.payload['reason'] === 'spawn-depth-exceeded');
  assert.ok(denials.length >= 1, 'depth exhaustion is denied at the kernel and journaled');
  assertInvariants({ kernel: k, storage }, 'recursion bound');
});

test('recursive delegation cannot outlive the invocation budget either', async () => {
  const { k, storage } = setup();
  const { recursiveCapability } = await import('../src/capabilities.ts');
  recursiveCapability.depthReached = 0;
  const e = k.createExecution();
  // Deep spawn allowance, but very little budget: the budget must bind first.
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 3, spawnDepth: 50 } });
  const out = await k.invoke(e, 'evil.recursive', { n: 0 }, g, { step: 'boom' });
  assert.equal(out.state, 'completed');
  const settled = [...k.state(e).grants.values()].find((x) => x.parent === undefined)!.settled['invocations'] ?? 0;
  assert.ok(settled <= 3, `spend stayed inside the grant (${settled} ≤ 3)`);
  assertInvariants({ kernel: k, storage }, 'budget-bounded recursion');
});
