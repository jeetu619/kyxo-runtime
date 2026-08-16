/**
 * graph-strategy.ts — a 3-node graph strategy (fan-out two parallel branches,
 * then join) expressed as a plain capability that invokes other capabilities
 * through the kernel. Graphs are an orchestration strategy, NOT kernel
 * material (spine §1): the kernel sees only bindings and invocations.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface Node { readonly op: string; readonly a: number; readonly b: number }
interface GraphRequest { readonly fanOut?: readonly Node[] }

export function makeGraphStrategy(deps: { readonly calc: string }): CapabilityProvider {
  const identity = { id: 'graph-strategy', version: '0.2.0', stability: 'experimental' } as const;
  return {
    identity,
    manifest: {
      identity,
      summary: 'Static 3-node graph: parallel fan-out of two branches + join node.',
      axes: {
        parallelism: { shape: 'tiered', tier: 'fan-out', ladder: ['sequential', 'fan-out'] },
        topology: { shape: 'options', offered: ['fanout-join-3'] },
        delegation: { shape: 'flag', enabled: true },
      },
      experimental: { dynamicSpawn: false },
      extensions: { 'dev.kyxo.graph': { nodes: ['branch-a', 'branch-b', 'join'] } },
    },

    async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
      const fanOut = ((request ?? {}) as GraphRequest).fanOut ?? [];
      if (fanOut.length !== 2) {
        yield { op: 'fail', error: `graph-strategy: expected exactly 2 fan-out nodes, got ${fanOut.length}` };
        return;
      }
      const calc = ctx.kernel.bind({
        capabilityId: deps.calc, grantId: ctx.grantId,
        requirements: [{ axis: 'operations', need: 'present' }],
      });
      yield { op: 'progress', note: 'fan-out: launching branch-a and branch-b in parallel' };
      // Parallel fan-out: two concurrent invocations in their own cells.
      const [ra, rb] = await Promise.all(
        fanOut.map((n) => ctx.kernel.invoke(calc.id, n, { causationId: ctx.invocationId })),
      );
      if (ra?.state !== 'completed' || rb?.state !== 'completed') {
        yield { op: 'fail', error: `graph-strategy: branch failed (a='${ra?.state}', b='${rb?.state}')` };
        return;
      }
      const va = (ra.output as { value: number }).value;
      const vb = (rb.output as { value: number }).value;
      yield { op: 'progress', note: `join: branch-a=${va}, branch-b=${vb}` };
      const joined = va + vb;
      yield { op: 'artifact', content: { nodes: { 'branch-a': va, 'branch-b': vb }, joined }, label: 'graph-run' };
      yield { op: 'result', output: { joined, branches: [va, vb] } };
    },
  };
}
