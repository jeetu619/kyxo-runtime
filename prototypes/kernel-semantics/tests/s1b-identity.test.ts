/**
 * S1b PART 2 / PART 16 — the effect-identity matrix, written as a careless developer.
 *
 * These are not adversarial tests. Every one of them is something an ordinary, competent
 * developer does on an ordinary Tuesday, and every one of them charged a card twice under
 * S1 with a green suite. The question this file answers is the one that decides the
 * freeze:
 *
 *   Can an ordinary developer accidentally create a double-charge path?
 *
 * Every test counts ACTUAL EXTERNAL EXECUTIONS. A returned status is not evidence; the
 * journal being tidy is not evidence. The card counter is evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { S1Kernel, ClaimDeniedError, AuthorizationError } from '../src/s1-kernel.ts';
import { EffectIdentityError, resolveEffectIdentity } from '../src/s1b-identity.ts';
import { Storage, CrashError } from '../src/storage.ts';
import type {
  CapabilityProvider, CapabilityResult, DelegationOutcome, EffectProposal, InvokeCtx,
} from '../src/types.ts';

/** The card. The only thing that counts. */
class Card {
  charges = 0;
  charge(): void { this.charges += 1; }
}

/**
 * A payment capability written by a developer who read the docs. It declares what makes
 * a charge the same charge: the invoice and the amount. Everything else in the request —
 * nonce, timestamp, trace id, retry counter — is incidental by construction, because it
 * was never named.
 */
function payments(card: Card): CapabilityProvider {
  return {
    manifest: {
      id: 'payments.stripe', version: '1.0.0',
      traits: {
        effectClass: 'external-irreversible', probeable: true, compensatable: false,
        resumable: true, streaming: false, cancellable: true, externallyStateful: false,
      },
      axes: {},
      identity: { operation: 'payments.charge', fields: ['invoiceId', 'amount', 'currency'] },
    },
    async *invoke(): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined> {
      card.charge();
      yield { type: 'external', descriptor: 'charge', landed: true };
      return { status: 'ok', output: { receipt: 'r' } };
    },
    async probe(): Promise<'landed' | 'not-landed' | 'unknown'> { return 'landed'; },
  };
}

/** The same developer, before they read the docs: no identity declared at all. */
function carelessPayments(card: Card): CapabilityProvider {
  const p = payments(card);
  return { ...p, manifest: { ...p.manifest, id: 'payments.careless', identity: undefined } };
}

const GRANT = { rights: ['pay'], limits: { invocations: 100, usd: 10_000 } };

function setup(card: Card, extra?: CapabilityProvider) {
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payments(card));
  if (extra !== undefined) k.register(extra);
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  return { k, storage, exec, grant };
}

async function attempt(
  k: S1Kernel, exec: never, grant: never, request: unknown, opts: Record<string, unknown> = {},
): Promise<string> {
  try {
    const out = await k.invoke(exec, 'payments.stripe', request, grant, opts as never);
    return out.deduplicated === true ? 'deduplicated' : out.state;
  } catch (err) {
    if (err instanceof ClaimDeniedError) return 'refused';
    if (err instanceof EffectIdentityError) return 'identity-refused';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The matrix: same semantic effect, incidental data varying
// ---------------------------------------------------------------------------

const INVOICE = { invoiceId: 'INV-42', amount: 100, currency: 'USD' };

test('ID1: same effect, byte-identical request — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  assert.equal(await attempt(f.k, f.exec as never, f.grant as never, INVOICE), 'completed');
  assert.equal(await attempt(f.k, f.exec as never, f.grant as never, INVOICE), 'refused');
  assert.equal(card.charges, 1);
});

test('ID2: same effect, fresh idempotency nonce per attempt — one charge', async () => {
  // THE canonical S1 failure. Stripe's own guidance is to send a fresh key per attempt,
  // so this is the habit a payments developer arrives with.
  const card = new Card();
  const f = setup(card);
  for (const nonce of ['n-1', 'n-2', 'n-3']) {
    await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, nonce });
  }
  assert.equal(card.charges, 1, 'a nonce is incidental; it cannot make a new charge');
});

test('ID3: same effect, different timestamp — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, requestedAt: 1000 });
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, requestedAt: 2000 });
  assert.equal(card.charges, 1);
});

test('ID4: same effect, different trace and correlation ids — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, traceId: 'a', correlationId: 'x' });
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, traceId: 'b', correlationId: 'y' });
  assert.equal(card.charges, 1);
});

test('ID5: same effect, JSON property order changed — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, { invoiceId: 'INV-42', amount: 100, currency: 'USD' });
  await attempt(f.k, f.exec as never, f.grant as never, { currency: 'USD', amount: 100, invoiceId: 'INV-42' });
  assert.equal(card.charges, 1, 'canonicalisation sorts keys; property order is not semantic');
});

test('ID6: same effect, extra observability metadata added later — one charge', async () => {
  // A developer adds telemetry to an existing call. Under an allowlist this cannot
  // change identity; under a blocklist someone would have had to predict the field.
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);
  await attempt(f.k, f.exec as never, f.grant as never, {
    ...INVOICE, _telemetry: { sdk: '2.1.0', host: 'worker-7', attempt: 3 },
  });
  assert.equal(card.charges, 1);
});

test('ID7: same effect, forgotten step — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE, { step: 'charge-customer' });
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);   // step omitted entirely
  assert.equal(card.charges, 1, 'a declared identity does not depend on the caller remembering `step`');
});

test('ID8: same effect after a runtime restart — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);

  const { kernel: k2 } = S1Kernel.recover(f.storage, [payments(card)]);
  const g2 = k2.rehydrateGrant(f.exec, f.grant.id);
  assert.equal(await attempt(k2, f.exec as never, g2 as never, { ...INVOICE, nonce: 'fresh-after-restart' }), 'refused');
  assert.equal(card.charges, 1);
});

test('ID9: same effect from a sibling fork and a nested fork — one charge', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);

  const cut = f.k.familyFor(f.exec).executions.get(f.exec)!.seq;
  const sibling = f.k.fork(f.exec, cut);
  const nested = f.k.fork(sibling, 1);
  for (const e of [sibling, nested]) {
    const g = f.k.rehydrateGrant(e, f.grant.id);
    try {
      await f.k.invoke(e, 'payments.stripe', { ...INVOICE, nonce: 'fork' }, g, {});
    } catch (err) {
      assert.ok(err instanceof ClaimDeniedError);
    }
  }
  assert.equal(card.charges, 1, 'the external world is not forked');
});

test('ID10: same effect after a consumer retry following a crash — one charge', async () => {
  const card = new Card();
  const storage = new Storage();
  const k1 = new S1Kernel(storage);
  k1.register(payments(card));
  const exec = k1.createExecution();
  const grant = k1.issueGrant(exec, GRANT);

  storage.armCrashWhen((s) => s.includes('"kind":"invocation.completed"'), { label: 'settle' });
  await assert.rejects(
    () => k1.invoke(exec, 'payments.stripe', INVOICE, grant, {}),
    (e: unknown) => e instanceof CrashError,
  );
  storage.disarm();
  assert.equal(card.charges, 1, 'the charge really happened');

  const { kernel: k2, uncertain } = S1Kernel.recover(storage, [payments(card)]);
  assert.equal(uncertain.length, 1, 'the OUTCOME is unknown, and stays unknown');

  const g2 = k2.rehydrateGrant(exec, grant.id);
  await assert.rejects(
    () => k2.invoke(exec, 'payments.stripe', { ...INVOICE, nonce: 'retry' }, g2, {}),
    (e: unknown) => e instanceof ClaimDeniedError,
    'an uncertain outcome must not be auto-retried into a second charge',
  );
  assert.equal(card.charges, 1);
});

// ---------------------------------------------------------------------------
// The other direction: different effects must NOT collide
// ---------------------------------------------------------------------------

test('ID11: different amount is a different effect — two charges', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, amount: 250 });
  assert.equal(card.charges, 2, 'over-dedup is the mirror-image failure and equally wrong');
});

test('ID12: different invoice is a different effect — two charges', async () => {
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, invoiceId: 'INV-43' });
  assert.equal(card.charges, 2);
});

test('ID13: a caller key may override a DECLARED schema only by saying so explicitly', async () => {
  // SUPERSEDED BEHAVIOUR (docs/30 F-40). S1b's first draft gave the caller key
  // unconditional precedence. Two independent reviewers broke it the same ordinary way: a
  // developer following every payments tutorial passed `idempotencyKey: randomUUID()` and
  // got three charges. The option NAMED FOR the problem had reintroduced it.
  //
  // The precedence was backwards. A schema is an audited artifact shipped with the
  // capability; a call-site string is neither.
  const card = new Card();
  const f = setup(card);

  await assert.rejects(
    () => f.k.invoke(f.exec, 'payments.stripe', INVOICE, f.grant, { idempotencyKey: 'job-7' }),
    (e: unknown) => e instanceof EffectIdentityError && /overrideCapabilityIdentity/.test(e.message),
  );
  assert.equal(card.charges, 0);

  const o = { overrideCapabilityIdentity: true };
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE, { idempotencyKey: 'job-7', ...o });
  await attempt(f.k, f.exec as never, f.grant as never, { ...INVOICE, amount: 999 }, { idempotencyKey: 'job-7', ...o });
  assert.equal(card.charges, 1, 'an explicit override still means what it says');
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE, { idempotencyKey: 'job-8', ...o });
  assert.equal(card.charges, 2, 'and a deliberate re-bill remains possible');
});

test('ID13b: the tutorial habit is REFUSED, not silently honoured (F-40)', async () => {
  const card = new Card();
  const f = setup(card);
  for (const n of [1, 2, 3]) {
    await assert.rejects(
      () => f.k.invoke(f.exec, 'payments.stripe', INVOICE, f.grant, { idempotencyKey: `attempt-${String(n)}` }),
      (e: unknown) => e instanceof EffectIdentityError,
    );
  }
  assert.equal(card.charges, 0, 'a per-attempt nonce must never become a per-attempt charge');
});

test('ID14: namespaces separate tenants whose business ids collide', async () => {
  const card = new Card();
  const f = setup(card, carelessPayments(card));
  const call = (namespace: string) =>
    f.k.invoke(f.exec, 'payments.careless', INVOICE, f.grant, { idempotencyKey: 'INV-1', namespace });
  await call('tenant-a');
  await call('tenant-b');
  assert.equal(card.charges, 2, 'two tenants, two charges');
});

test('ID25: effectClassOverride cannot silently downgrade an irreversible capability (F-41)', async () => {
  // Found INDEPENDENTLY by two reviewers, which is the strongest signal a finding is
  // structural. One type-correct option removed protection, the fail-closed identity rule
  // and the exclusive claim together, with none of the ceremony the identity escape hatch
  // carries — a strictly more powerful escape hatch, free, in no doc and no test.
  const card = new Card();
  const f = setup(card, carelessPayments(card));
  await assert.rejects(
    () => f.k.invoke(f.exec, 'payments.careless', INVOICE, f.grant, {
      effectClassOverride: 'external-idempotent',
    }),
    (e: unknown) => e instanceof AuthorizationError && /unsafe-effect-class-downgrade/.test(e.message),
  );
  assert.equal(card.charges, 0);

  const g = f.k.issueGrant(f.exec, {
    rights: ['pay', 'unsafe-effect-class-downgrade'], limits: { invocations: 10, usd: 100 },
  });
  await f.k.invoke(f.exec, 'payments.careless', INVOICE, g, { effectClassOverride: 'external-idempotent' });
  const familyId = f.k.familyFor(f.exec).familyId;
  assert.equal(
    f.k.events(familyId).filter(
      (e) => e.kind === 'policy.denied' && e.payload['reason'] === 'effect-class-downgraded').length,
    1, 'a downgrade is a journaled event, not a silent option');
});

// ---------------------------------------------------------------------------
// Fail-closed when identity is absent
// ---------------------------------------------------------------------------

test('ID15: an irreversible capability with no declared identity is REFUSED, not guessed', async () => {
  // The single most important test in S1b. Under S1 this fell back to hashing the whole
  // request and charged once per nonce. Convenience does not get to become a
  // double-charge risk by default.
  const card = new Card();
  const f = setup(card, carelessPayments(card));
  await assert.rejects(
    () => f.k.invoke(f.exec, 'payments.careless', INVOICE, f.grant, {}),
    (e: unknown) => e instanceof EffectIdentityError && /no effect identity/.test(e.message),
  );
  assert.equal(card.charges, 0, 'nothing was charged, because nothing was admitted');
});

test('ID16: the careless capability becomes usable the moment the CALLER supplies identity', async () => {
  const card = new Card();
  const f = setup(card, carelessPayments(card));
  for (const nonce of ['a', 'b', 'c']) {
    try {
      await f.k.invoke(f.exec, 'payments.careless', { ...INVOICE, nonce }, f.grant, { idempotencyKey: 'INV-42' });
    } catch (err) { assert.ok(err instanceof ClaimDeniedError); }
  }
  assert.equal(card.charges, 1, 'either side may supply identity; neither may omit it');
});

test('ID17: a repeatable class needs no declared identity', async () => {
  // Fail-closed applies where repetition is dangerous, not everywhere. A `local` or
  // `external-idempotent` capability is repeatable by declaration and is not burdened.
  const card = new Card();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register({
    ...payments(card),
    manifest: {
      ...payments(card).manifest, id: 'search', identity: undefined,
      traits: { ...payments(card).manifest.traits, effectClass: 'external-idempotent' },
    },
  });
  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  const out = await k.invoke(exec, 'search', { q: 'weather', nonce: 'x' }, grant, {});
  assert.equal(out.state, 'completed');
});

// ---------------------------------------------------------------------------
// The escape hatch (PART 17)
// ---------------------------------------------------------------------------

test('ID18: the unsafe escape hatch is rights-gated, journaled, and named', async () => {
  const card = new Card();
  const f = setup(card, carelessPayments(card));

  // Without the right: refused, even though the caller asked explicitly.
  await assert.rejects(
    () => f.k.invoke(f.exec, 'payments.careless', INVOICE, f.grant, {
      unsafeRequestHashIdentity: { reason: 'legacy migration' },
    }),
    (e: unknown) => e instanceof AuthorizationError && /unsafe-effect-identity/.test(e.message),
    'asking for unsafe behaviour is not the same as being permitted it',
  );
  assert.equal(card.charges, 0);

  // With the right: permitted, and recorded with its reason.
  const unsafeGrant = f.k.issueGrant(f.exec, {
    rights: ['pay', 'unsafe-effect-identity'], limits: { invocations: 10, usd: 100 },
  });
  await f.k.invoke(f.exec, 'payments.careless', INVOICE, unsafeGrant, {
    unsafeRequestHashIdentity: { reason: 'legacy migration' },
  });
  assert.equal(card.charges, 1);

  const familyId = f.k.familyFor(f.exec).familyId;
  const admitted = f.k.events(familyId).filter((e) => e.kind === 'invocation.admitted');
  const unsafeRecord = admitted.find((e) => e.payload['unsafeIdentityReason'] !== undefined);
  assert.ok(unsafeRecord !== undefined, 'the unsafe choice is in the journal, not just in a call site');
  assert.equal(unsafeRecord.payload['unsafeIdentityReason'], 'legacy migration');
  assert.equal(
    (unsafeRecord.payload['identity'] as { source: string }).source, 'unsafe-request-hash',
    'and the record says which identity model produced this key',
  );
});

test('ID19: the escape hatch does not propagate to delegated invocations', async () => {
  // An unsafe choice is made about ONE call by someone who accepted the risk. Inheriting
  // it downward would let one legacy call quietly disable protection for a whole subtree.
  const card = new Card();
  const f = setup(card, carelessPayments(card));
  const unsafeGrant = f.k.issueGrant(f.exec, {
    rights: ['pay', 'unsafe-effect-identity'], limits: { invocations: 10, usd: 100, spawnDepth: 1 },
  });
  await f.k.invoke(f.exec, 'payments.careless', INVOICE, unsafeGrant, {
    unsafeRequestHashIdentity: { reason: 'legacy' },
  });
  const familyId = f.k.familyFor(f.exec).familyId;
  const unsafeCount = f.k.events(familyId)
    .filter((e) => e.payload['unsafeIdentityReason'] !== undefined).length;
  assert.equal(unsafeCount, 1, 'exactly the one invocation that asked for it');
});

// ---------------------------------------------------------------------------
// Cross-version stability (PART 8)
// ---------------------------------------------------------------------------

test('ID20: identity is persisted, so a reader never re-derives it', async () => {
  // If a future revision changed the derivation and the fold recomputed identities, every
  // effect in history would become a NEW effect and every one of them would be repeatable.
  // The recorded key is authoritative forever.
  const card = new Card();
  const f = setup(card);
  await attempt(f.k, f.exec as never, f.grant as never, INVOICE);

  const familyId = f.k.familyFor(f.exec).familyId;
  const admitted = f.k.events(familyId).find((e) => e.kind === 'invocation.admitted')!;
  const identity = admitted.payload['identity'] as { scheme: string; source: string; operation: string };
  assert.equal(identity.scheme, 'kyxo.effect-identity/1', 'the scheme is named in the record');
  assert.equal(identity.source, 'capability-schema');
  assert.equal(identity.operation, 'payments.charge');

  // The key itself is in the record, not implied by it.
  assert.equal(typeof admitted.payload['effectKey'], 'string');
  const landed = f.k.events(familyId).find((e) => e.kind === 'effect.landed')!;
  assert.equal(landed.payload['effectKey'], admitted.payload['effectKey']);
});

test('ID21: a wrapper capability preserves identity — wrapping is not a double charge', async () => {
  // PART 16: "wrap an existing capability". Two capabilities declaring the same operation
  // ARE the same operation; identity is anchored on the operation name, not the
  // capability id, precisely so that a wrapper, a retry shim or a v2 rollout does not
  // silently re-charge everything.
  const card = new Card();
  const storage = new Storage();
  const k = new S1Kernel(storage);
  k.register(payments(card));
  const inner = payments(card);
  k.register({ ...inner, manifest: { ...inner.manifest, id: 'payments.wrapped' } });

  const exec = k.createExecution();
  const grant = k.issueGrant(exec, GRANT);
  await k.invoke(exec, 'payments.stripe', INVOICE, grant, {});
  await assert.rejects(
    () => k.invoke(exec, 'payments.wrapped', INVOICE, grant, {}),
    (e: unknown) => e instanceof ClaimDeniedError,
  );
  assert.equal(card.charges, 1);
});

test('ID22: identity refuses values it cannot represent, rather than hashing them to nothing', async () => {
  const card = new Card();
  const f = setup(card);
  await assert.rejects(
    () => f.k.invoke(f.exec, 'payments.stripe', { ...INVOICE, amount: new Date(0) as never }, f.grant, {}),
    (e: unknown) => e instanceof Error && /canonicalis/.test(e.message),
    'a Date in an identity field hashed to {} under S1, colliding two different charges',
  );
  assert.equal(card.charges, 0);
});

test('ID23: a schema that matches nothing in the request is refused', async () => {
  // Every identity field absent means the schema does not describe this request, so every
  // such request would share one key — a collision presented as an identity.
  assert.throws(
    () => resolveEffectIdentity({
      capabilityId: 'x', effectClass: 'external-irreversible',
      request: { unrelated: 1 },
      schema: { operation: 'op', fields: ['invoiceId', 'amount'] },
    }),
    (e: unknown) => e instanceof EffectIdentityError && /none of its identity fields/.test(e.message),
  );
});

test('ID24: an absent optional identity field is deterministic, not fatal and not omitted', async () => {
  const a = resolveEffectIdentity({
    capabilityId: 'x', effectClass: 'external-irreversible',
    request: { invoiceId: 'I1' }, schema: { operation: 'op', fields: ['invoiceId', 'currency'] },
  });
  const b = resolveEffectIdentity({
    capabilityId: 'x', effectClass: 'external-irreversible',
    request: { invoiceId: 'I1' }, schema: { operation: 'op', fields: ['invoiceId', 'currency'] },
  });
  const c = resolveEffectIdentity({
    capabilityId: 'x', effectClass: 'external-irreversible',
    request: { invoiceId: 'I1', currency: 'USD' }, schema: { operation: 'op', fields: ['invoiceId', 'currency'] },
  });
  assert.equal(a.key, b.key, 'absence is stable');
  assert.notEqual(a.key, c.key, 'and absence is not the same as presence');
});
