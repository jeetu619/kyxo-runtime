/**
 * Long-running seeded fuzz driver (separate CI profile from the fast gates).
 *
 *   KYXO_FUZZ_SEEDS=2000 KYXO_FUZZ_LENGTH=80 \
 *     node --experimental-strip-types kernel-semantics/fuzz.ts
 *
 * Prints the failing seed and the minimized operation sequence on the first failure,
 * so any failure is reproducible with a single seed.
 */

import { Kernel, AuthorizationError, BudgetError, ForkError } from './src/kernel.ts';
import { Storage, CrashError } from './src/storage.ts';
import { checkInvariants, snapshotByExecution } from './src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability } from './src/capabilities.ts';
import type { ExecutionId, GrantHandle, InvocationId } from './src/types.ts';

const SEEDS = Number(process.env['KYXO_FUZZ_SEEDS'] ?? 300);
const LENGTH = Number(process.env['KYXO_FUZZ_LENGTH'] ?? 60);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op = { op: string; a: number; b: number };

function generate(r: () => number, n: number): Op[] {
  const kinds = ['invoke', 'invokeExternal', 'invokeIrreversible', 'duplicate', 'gate',
    'checkpoint', 'fork', 'attenuate', 'revoke', 'cancel', 'crash', 'resolve'];
  return Array.from({ length: n }, () => ({
    op: kinds[Math.floor(r() * kinds.length)]!,
    a: Math.floor(r() * 5),
    b: Math.floor(r() * 5),
  }));
}

interface World {
  kernel: Kernel;
  storage: Storage;
  pay: PaymentCapability;
  execs: ExecutionId[];
  grants: Map<ExecutionId, GrantHandle[]>;
}

function boot(): World {
  const storage = new Storage();
  const kernel = new Kernel(storage);
  const pay = new PaymentCapability();
  for (const c of ALL_CAPABILITIES) kernel.register(c);
  kernel.register(pay);
  const e = kernel.createExecution();
  const g = kernel.issueGrant(e, {
    rights: ['compute', 'write', 'remote', 'pay'],
    limits: { invocations: 30, spawnDepth: 2 },
  });
  return { kernel, storage, pay, execs: [e], grants: new Map([[e, [g]]]) };
}

async function step(w: World, op: Op, r: () => number): Promise<void> {
  const exec = w.execs[Math.floor(r() * w.execs.length)]!;
  const grants = w.grants.get(exec) ?? [];
  if (grants.length === 0) return;
  const grant = grants[Math.floor(r() * grants.length)]!;
  const step = `s${op.a}`;

  switch (op.op) {
    case 'invoke':
      await w.kernel.invoke(exec, 'tool.calc', { a: op.a, b: op.b }, grant, { step });
      break;
    case 'invokeExternal':
      await w.kernel.invoke(exec, 'remote.a2a', { task: op.a }, grant, { step });
      break;
    case 'invokeIrreversible':
      await w.kernel.invoke(exec, 'payment.charge', { amount: op.a }, grant, { step });
      break;
    case 'duplicate':
      await w.kernel.invoke(exec, 'mcp.files', { path: `p${op.a}`, content: `v${op.b}` }, grant, { step, duplicateDelivery: true });
      break;
    case 'gate':
      await w.kernel.invoke(exec, 'evil.bypass', { n: op.a }, grant, { step, requiresEvidence: true });
      break;
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
      w.grants.set(child, [...grants]);
      break;
    }
    case 'attenuate':
      w.grants.set(exec, [...grants, w.kernel.attenuate(exec, grant, { rights: ['compute'], limits: { invocations: 2, spawnDepth: 1 } })]);
      break;
    case 'revoke':
      if (grants.length > 1) w.kernel.revoke(exec, grants[grants.length - 1]!);
      break;
    case 'cancel': {
      const ids = [...w.kernel.state(exec).invocations.keys()];
      if (ids.length > 0) w.kernel.cancel(exec, ids[Math.floor(r() * ids.length)] as InvocationId, 'fuzz');
      break;
    }
    case 'crash': {
      w.pay.crashAfterLanding = true;
      try {
        await w.kernel.invoke(exec, 'payment.charge', { amount: 900 + op.a }, grant, { step: `crash${op.a}` });
      } finally {
        w.pay.crashAfterLanding = false;
      }
      break;
    }
    case 'resolve': {
      const u = [...w.kernel.state(exec).invocations.values()].find((i) => i.state === 'uncertain');
      if (u !== undefined) {
        await w.kernel.resolveUncertainty(exec, u.id, r() < 0.5 ? { kind: 'probe' } : { kind: 'abandon-failed', authority: 'fuzz' });
      }
      break;
    }
  }
}

async function run(seed: number, ops: Op[]): Promise<string | null> {
  let w = boot();
  const r = rng(seed ^ 0x85ebca6b);
  for (let i = 0; i < ops.length; i += 1) {
    const prior = snapshotByExecution(w.storage);
    try {
      await step(w, ops[i]!, r);
    } catch (err) {
      if (err instanceof CrashError) {
        // Restart from durable state, as a real supervisor would.
        const rec = Kernel.recover(w.storage, [...ALL_CAPABILITIES, w.pay]);
        const kernel = rec.kernel;
        const grants = new Map<ExecutionId, GrantHandle[]>();
        for (const e of w.execs) {
          grants.set(e, [kernel.issueGrant(e, { rights: ['compute', 'write', 'remote', 'pay'], limits: { invocations: 30, spawnDepth: 2 } })]);
        }
        w = { ...w, kernel, grants };
      } else if (!(err instanceof AuthorizationError || err instanceof BudgetError || err instanceof ForkError)) {
        return `op#${i} (${ops[i]!.op}) threw unexpectedly: ${String(err)}`;
      }
    }
    const violations = checkInvariants({ kernel: w.kernel, storage: w.storage, priorByExecution: prior });
    if (violations.length > 0) {
      return `op#${i} (${ops[i]!.op}): ` + violations.map((v) => `[${v.id}] ${v.detail}`).join('; ');
    }
  }
  return null;
}

async function minimize(seed: number, ops: Op[]): Promise<Op[]> {
  let cur = ops;
  let changed = true;
  while (changed && cur.length > 1) {
    changed = false;
    for (let i = 0; i < cur.length; i += 1) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + 1)];
      if ((await run(seed, cand)) !== null) {
        cur = cand;
        changed = true;
        break;
      }
    }
  }
  return cur;
}

let failures = 0;
const started = Date.now();
for (let seed = 1; seed <= SEEDS; seed += 1) {
  const ops = generate(rng(seed), LENGTH);
  const failure = await run(seed, ops);
  if (failure !== null) {
    failures += 1;
    const min = await minimize(seed, ops);
    console.error(`FAIL seed=${seed}: ${failure}`);
    console.error(`  minimized (${min.length} ops): ${JSON.stringify(min)}`);
    if (failures >= 3) break;
  }
  if (seed % 100 === 0) console.log(`  ...${seed}/${SEEDS} seeds clean`);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (failures === 0) {
  console.log(`OK: ${SEEDS} seeds x ${LENGTH} ops clean in ${elapsed}s`);
  process.exit(0);
} else {
  console.error(`${failures} failing seed(s)`);
  process.exit(1);
}
