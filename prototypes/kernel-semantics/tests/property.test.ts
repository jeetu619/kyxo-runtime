/**
 * Seeded property testing + differential comparison against the reference model.
 *
 * Long randomized operation sequences are generated from a reproducible seed. After
 * EVERY operation all invariants are asserted, and the kernel's observable state is
 * compared with the independent reference model. On failure the seed and the minimized
 * operation sequence are printed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, AuthorizationError, BudgetError, ForkError } from '../src/kernel.ts';
import { Storage, CrashError } from '../src/storage.ts';
import { checkInvariants, snapshotByExecution } from '../src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability } from '../src/capabilities.ts';
import { ReferenceModel } from '../reference-model/model.ts';
import type { ExecutionId, GrantHandle, InvocationId } from '../src/types.ts';

/** Deterministic PRNG (mulberry32) — same seed, same sequence, always. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { op: 'invoke'; cap: string; arg: number; step: string; evidence: boolean }
  | { op: 'duplicate'; cap: string; arg: number; step: string }
  | { op: 'checkpoint' }
  | { op: 'fork' }
  | { op: 'attenuate' }
  | { op: 'revoke' }
  | { op: 'cancel' }
  | { op: 'crashRestart' }
  | { op: 'resolveUncertainty' };

const SAFE_CAPS = ['tool.calc', 'mcp.files', 'llm.mock', 'llm.local'];

function generate(r: () => number, length: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = r();
    const cap = SAFE_CAPS[Math.floor(r() * SAFE_CAPS.length)]!;
    const arg = Math.floor(r() * 5);
    const step = `s${Math.floor(r() * 6)}`;
    if (roll < 0.42) ops.push({ op: 'invoke', cap, arg, step, evidence: r() < 0.15 });
    else if (roll < 0.52) ops.push({ op: 'duplicate', cap, arg, step });
    else if (roll < 0.64) ops.push({ op: 'checkpoint' });
    else if (roll < 0.74) ops.push({ op: 'fork' });
    else if (roll < 0.82) ops.push({ op: 'attenuate' });
    else if (roll < 0.86) ops.push({ op: 'revoke' });
    else if (roll < 0.90) ops.push({ op: 'cancel' });
    else if (roll < 0.97) ops.push({ op: 'crashRestart' });
    else ops.push({ op: 'resolveUncertainty' });
  }
  return ops;
}

interface World {
  kernel: Kernel;
  storage: Storage;
  model: ReferenceModel;
  execs: ExecutionId[];
  grants: Map<ExecutionId, GrantHandle[]>;
  pay: PaymentCapability;
}

function newWorld(): World {
  const storage = new Storage();
  const kernel = new Kernel(storage);
  const pay = new PaymentCapability();
  for (const c of ALL_CAPABILITIES) kernel.register(c);
  kernel.register(pay);
  const model = new ReferenceModel();
  const e = kernel.createExecution();
  model.createExecution(e);
  const g = kernel.issueGrant(e, { rights: ['compute', 'write', 'remote'], limits: { invocations: 25, spawnDepth: 2 } });
  model.issueGrant(e, g.id, ['compute', 'write', 'remote'], { invocations: 25, spawnDepth: 2 });
  return { kernel, storage, model, execs: [e], grants: new Map([[e, [g]]]), pay };
}

/** Apply one operation. Expected exceptions are tolerated; unexpected ones fail. */
async function apply(w: World, op: Op, r: () => number): Promise<void> {
  const exec = w.execs[Math.floor(r() * w.execs.length)]!;
  const grants = w.grants.get(exec) ?? [];
  if (grants.length === 0) return;
  const grant = grants[Math.floor(r() * grants.length)]!;

  try {
    switch (op.op) {
      case 'invoke':
      case 'duplicate': {
        const request = op.cap === 'mcp.files'
          ? { path: `p${op.arg}`, content: `v${op.arg}` }
          : { a: op.arg, b: op.arg };
        await w.kernel.invoke(exec, op.cap, request, grant, {
          step: op.step,
          duplicateDelivery: op.op === 'duplicate',
          ...(op.op === 'invoke' && op.evidence ? { requiresEvidence: true } : {}),
        });
        break;
      }
      case 'checkpoint':
        w.kernel.checkpoint(exec);
        break;
      case 'fork': {
        const cps = w.kernel.events(exec).filter((e) => e.kind === 'checkpoint.cut');
        if (cps.length === 0) return;
        const cpId = cps[Math.floor(r() * cps.length)]!.payload['checkpointId'] as string;
        const cp = w.kernel.getCheckpoint(cpId as never);
        if (cp === undefined) return;
        const dispositions: Record<string, 'adopt' | 'abandon'> = {};
        for (const p of cp.pending) dispositions[p.id] = r() < 0.5 ? 'adopt' : 'abandon';
        const child = w.kernel.fork(cpId as never, { dispositions });
        w.execs.push(child);
        w.grants.set(child, [...(w.grants.get(exec) ?? [])]);
        break;
      }
      case 'attenuate': {
        const child = w.kernel.attenuate(exec, grant, { rights: ['compute'], limits: { invocations: 2, spawnDepth: 1 } });
        w.grants.set(exec, [...grants, child]);
        break;
      }
      case 'revoke':
        if (grants.length > 1) w.kernel.revoke(exec, grants[grants.length - 1]!);
        break;
      case 'cancel': {
        const invocations = [...w.kernel.state(exec).invocations.keys()];
        if (invocations.length > 0) {
          w.kernel.cancel(exec, invocations[Math.floor(r() * invocations.length)] as InvocationId, 'property-test');
        }
        break;
      }
      case 'crashRestart': {
        // Restart from durable state only. Everything in memory is lost.
        const rec = Kernel.recover(w.storage, [...ALL_CAPABILITIES, w.pay]);
        w.kernel = rec.kernel;
        // Grant handles do NOT survive a restart: authority must be re-obtained.
        // The kernel that recovered has no minted handles, so re-issue for the test.
        for (const e of w.execs) {
          const g = w.kernel.issueGrant(e, { rights: ['compute', 'write', 'remote'], limits: { invocations: 25, spawnDepth: 2 } });
          w.grants.set(e, [g]);
        }
        break;
      }
      case 'resolveUncertainty': {
        const uncertain = [...w.kernel.state(exec).invocations.values()].find((i) => i.state === 'uncertain');
        if (uncertain !== undefined) {
          await w.kernel.resolveUncertainty(exec, uncertain.id, { kind: 'abandon-failed', authority: 'property-test' });
        }
        break;
      }
    }
  } catch (err) {
    const expected =
      err instanceof AuthorizationError ||
      err instanceof BudgetError ||
      err instanceof ForkError ||
      err instanceof CrashError;
    if (!expected) throw err;
  }
}

async function runSequence(seed: number, ops: Op[]): Promise<string | null> {
  const w = newWorld();
  const r = rng(seed ^ 0x9e3779b9);
  for (let i = 0; i < ops.length; i += 1) {
    const prior = snapshotByExecution(w.storage);
    await apply(w, ops[i]!, r);
    const violations = checkInvariants({ kernel: w.kernel, storage: w.storage, priorByExecution: prior });
    if (violations.length > 0) {
      return `op#${i} (${ops[i]!.op}): ` + violations.map((x) => `[${x.id}] ${x.detail}`).join('; ');
    }
  }
  return null;
}

/** Delta-debugging style minimizer: drop operations while the failure persists. */
async function minimize(seed: number, ops: Op[]): Promise<Op[]> {
  let current = ops;
  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if ((await runSequence(seed, candidate)) !== null) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

test('invariants hold across 120 seeded random operation sequences', async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 120; seed += 1) {
    const ops = generate(rng(seed), 40);
    const failure = await runSequence(seed, ops);
    if (failure !== null) {
      const min = await minimize(seed, ops);
      failures.push(`seed=${seed} ${failure}\n  minimized(${min.length}): ${JSON.stringify(min)}`);
      if (failures.length >= 3) break;
    }
  }
  assert.deepEqual(failures, [], `property failures:\n${failures.join('\n')}`);
});

test('differential: kernel matches the reference model on invocation outcomes and budgets', async () => {
  for (let seed = 200; seed <= 240; seed += 1) {
    const r = rng(seed);
    const storage = new Storage();
    const kernel = new Kernel(storage);
    for (const c of ALL_CAPABILITIES) kernel.register(c);
    const model = new ReferenceModel();

    const exec = kernel.createExecution();
    model.createExecution(exec);
    const root = kernel.issueGrant(exec, { rights: ['compute', 'write'], limits: { invocations: 8, spawnDepth: 1 } });
    model.issueGrant(exec, root.id, ['compute', 'write'], { invocations: 8, spawnDepth: 1 });

    for (let i = 0; i < 25; i += 1) {
      const arg = Math.floor(r() * 4);
      const step = `s${Math.floor(r() * 4)}`;
      const key = `${'tool.calc'}|${step}|${arg}`;

      const actual = await kernel.invoke(exec, 'tool.calc', { a: arg, b: arg }, root, { step }).then(
        (o) => (o.deduplicated === true ? 'deduplicated' : o.state),
        (e) => (e instanceof BudgetError || e instanceof AuthorizationError ? 'denied' : `threw:${String(e)}`),
      );

      const expected = model.invoke(exec, `i${i}`, root.id, key as never, 'pure', 'ok').state;

      assert.equal(actual, expected, `seed=${seed} op#${i}: kernel=${actual} model=${expected}`);
    }

    // Budgets must agree exactly.
    const kernelGrant = kernel.state(exec).grants.get(root.id as never)!;
    const modelGrant = model.exec(exec).grants.get(root.id)!;
    assert.equal(
      kernelGrant.settled['invocations'] ?? 0,
      modelGrant.settled['invocations'] ?? 0,
      `seed=${seed}: settled budget diverged`,
    );
  }
});

test('differential: fork isolation matches the model (no post-cut leakage)', async () => {
  for (let seed = 300; seed <= 320; seed += 1) {
    const r = rng(seed);
    const storage = new Storage();
    const kernel = new Kernel(storage);
    for (const c of ALL_CAPABILITIES) kernel.register(c);

    const parent = kernel.createExecution();
    const g = kernel.issueGrant(parent, { rights: ['write'], limits: { invocations: 30, spawnDepth: 1 } });

    const preCut = Math.floor(r() * 3) + 1;
    for (let i = 0; i < preCut; i += 1) {
      await kernel.invoke(parent, 'mcp.files', { path: `pre${i}`, content: 'x' }, g, { step: `pre${i}` });
    }
    const cp = kernel.checkpoint(parent);

    const postCut = Math.floor(r() * 3) + 1;
    for (let i = 0; i < postCut; i += 1) {
      await kernel.invoke(parent, 'mcp.files', { path: `post${i}`, content: 'y' }, g, { step: `post${i}` });
    }

    const child = kernel.fork(cp.id, { dispositions: {} });
    const childCell = kernel.state(child).cell;
    for (let i = 0; i < preCut; i += 1) {
      assert.equal(childCell.get(`file:pre${i}`), 'x', `seed=${seed}: child must inherit pre-cut state`);
    }
    for (let i = 0; i < postCut; i += 1) {
      assert.equal(childCell.get(`file:post${i}`), undefined, `seed=${seed}: post-cut leakage into fork`);
    }
    // Parent keeps everything.
    const parentCell = kernel.state(parent).cell;
    assert.equal(parentCell.size, preCut + postCut, `seed=${seed}: parent state altered by fork`);
  }
});
