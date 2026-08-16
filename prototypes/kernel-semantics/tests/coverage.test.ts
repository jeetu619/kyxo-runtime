/**
 * Coverage guard.
 *
 * A property suite that passes without reaching interesting states is worthless. This
 * test measures what the generated sequences actually exercise and fails if the
 * distribution degenerates. The printed table is the evidence recorded in docs/20.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, AuthorizationError, BudgetError, ForkError } from '../src/kernel.ts';
import { Storage, CrashError } from '../src/storage.ts';
import { checkInvariants } from '../src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability } from '../src/capabilities.ts';
import type { EventKind } from '../src/types.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('generated workloads reach every semantically interesting state', async () => {
  const counts = new Map<EventKind | string, number>();
  const bump = (k: EventKind | string, n = 1): void => {
    counts.set(k, (counts.get(k) ?? 0) + n);
  };

  const SEEDS = 150;
  let totalOps = 0;
  let invariantChecks = 0;

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const r = rng(seed);
    const storage = new Storage();
    let kernel = new Kernel(storage);
    const pay = new PaymentCapability();
    for (const c of ALL_CAPABILITIES) kernel.register(c);
    kernel.register(pay);

    // A deny-class stage that refuses expensive irreversible effects at admission and
    // rejects lying evidence at commit — exercising BOTH policy phases.
    let policyArmed = false;
    kernel.addPolicy({
      name: 'spend-guard',
      denyClass: true,
      evaluate: ({ effectClass, phase, proposals }) => {
        if (phase === 'admission' && policyArmed && effectClass === 'external-irreversible') {
          return { decision: 'deny', reason: 'irreversible spend blocked while armed' };
        }
        if (phase === 'commit' && (proposals ?? []).some((p) => p.type === 'evidence' && p.verdict === 'fail')) {
          return { decision: 'deny', reason: 'failing evidence at commit' };
        }
        return { decision: 'allow' };
      },
    });

    const exec = kernel.createExecution();
    let grant = kernel.issueGrant(exec, {
      rights: ['compute', 'write', 'remote', 'pay'],
      limits: { invocations: 20, spawnDepth: 2 },
    });
    const execs = [exec];

    for (let i = 0; i < 30; i += 1) {
      totalOps += 1;
      const roll = r();
      policyArmed = r() < 0.4;
      try {
        if (roll < 0.35) {
          const caps = ['tool.calc', 'mcp.files', 'llm.mock', 'remote.a2a', 'payment.charge'];
          const cap = caps[Math.floor(r() * caps.length)]!;
          const arg = Math.floor(r() * 4);
          const req = cap === 'mcp.files' ? { path: `p${arg}`, content: `v${arg}` } : { a: arg, b: arg, amount: arg };
          await kernel.invoke(execs[0]!, cap, req, grant, { step: `s${Math.floor(r() * 5)}` });
        } else if (roll < 0.45) {
          await kernel.invoke(execs[0]!, 'tool.calc', { a: 1, b: 1 }, grant, { step: 'dup', duplicateDelivery: true });
        } else if (roll < 0.55) {
          await kernel.invoke(execs[0]!, 'evil.bypass', {}, grant, { step: `gate${i}`, requiresEvidence: true });
        } else if (roll < 0.68) {
          kernel.checkpoint(execs[0]!);
        } else if (roll < 0.80) {
          const cps = kernel.events(execs[0]!).filter((e) => e.kind === 'checkpoint.cut');
          if (cps.length > 0) {
            const cpId = cps[cps.length - 1]!.payload['checkpointId'] as string;
            const cp = kernel.getCheckpoint(cpId as never);
            if (cp !== undefined) {
              const disp: Record<string, 'adopt' | 'abandon'> = {};
              for (const p of cp.pending) disp[p.id] = 'adopt';
              kernel.fork(cpId as never, { dispositions: disp });
              bump('forks');
            }
          }
        } else if (roll < 0.88) {
          // Crash mid-flight on an irreversible effect, then recover.
          pay.crashAfterLanding = true;
          try {
            await kernel.invoke(execs[0]!, 'payment.charge', { amount: 42 + i }, grant, { step: `pay${i}` });
          } catch (e) {
            if (e instanceof CrashError) bump('crashes');
            else if (!(e instanceof AuthorizationError) && !(e instanceof BudgetError)) throw e;
          } finally {
            pay.crashAfterLanding = false;
          }
          const rec = Kernel.recover(storage, [...ALL_CAPABILITIES, pay]);
          kernel = rec.kernel;
          bump('recoveries');
          bump('uncertainties', rec.uncertain.length);
          grant = kernel.issueGrant(execs[0]!, {
            rights: ['compute', 'write', 'remote', 'pay'],
            limits: { invocations: 20, spawnDepth: 2 },
          });
          for (const u of rec.uncertain) {
            await kernel.resolveUncertainty(execs[0]!, u, r() < 0.5 ? { kind: 'probe' } : { kind: 'compensate' });
            bump('uncertainty-resolutions');
          }
        } else if (roll < 0.94) {
          const child = kernel.attenuate(execs[0]!, grant, { rights: ['compute'], limits: { invocations: 2, spawnDepth: 1 } });
          bump('attenuations');
          await kernel.invoke(execs[0]!, 'tool.calc', { a: 9, b: 9 }, child, { step: `att${i}` });
        } else {
          const child = kernel.attenuate(execs[0]!, grant, { rights: ['compute'], limits: { invocations: 1, spawnDepth: 1 } });
          kernel.revoke(execs[0]!, child);
          bump('revocations');
          await kernel.invoke(execs[0]!, 'tool.calc', { a: 3, b: 3 }, child, { step: `rev${i}` });
        }
      } catch (err) {
        const expected = err instanceof AuthorizationError || err instanceof BudgetError ||
          err instanceof ForkError || err instanceof CrashError;
        if (!expected) throw err;
        bump(`expected-refusal:${(err as Error).constructor.name}`);
      }

      const violations = checkInvariants({ kernel, storage });
      invariantChecks += 1;
      assert.deepEqual(violations, [], `seed=${seed} op#${i}: ${violations.map((x) => x.id + ' ' + x.detail).join('; ')}`);
    }

    for (const e of kernel.executionIds()) {
      for (const ev of kernel.events(e)) bump(ev.kind);
    }
  }

  const report = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  seeds=${SEEDS} operations=${totalOps} invariant-checks=${invariantChecks}`);
  console.log('  ' + '-'.repeat(58));
  for (const [k, n] of report) console.log(`  ${String(k).padEnd(40)} ${String(n).padStart(8)}`);

  // Guard rails: the workload must actually reach these states.
  const required: [string, number][] = [
    ['forks', 50],
    ['crashes', 50],
    ['recoveries', 50],
    ['uncertainties', 50],
    ['uncertainty-resolutions', 50],
    ['revocations', 20],
    ['attenuations', 50],
    ['invocation.uncertain', 50],
    ['effect.deduplicated', 50],
    ['delivery.duplicate', 20],
    ['policy.denied', 20],
    ['execution.forked', 50],
    ['checkpoint.cut', 100],
    ['grant.reserved', 200],
    ['grant.settled', 200],
    ['grant.released', 50],
    ['invocation.completed', 200],
    ['invocation.failed', 50],
  ];
  const missing = required.filter(([k, min]) => (counts.get(k) ?? 0) < min);
  assert.deepEqual(
    missing.map(([k, min]) => `${k} (${counts.get(k) ?? 0} < ${min})`),
    [],
    'the generated workload degenerated: interesting states were not reached',
  );
});
