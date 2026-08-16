/**
 * calculator-tool.ts — a pure tool capability. Table of operations, no eval,
 * no state, no side effects. The smallest honest manifest in the set.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface CalcRequest { readonly op?: string; readonly a?: number; readonly b?: number }

const OPS: Readonly<Record<string, (a: number, b: number) => number>> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
};

export const calculatorTool: CapabilityProvider = {
  identity: { id: 'calculator', version: '2.1.0', stability: 'stable' },
  manifest: {
    identity: { id: 'calculator', version: '2.1.0', stability: 'stable' },
    summary: 'Pure arithmetic tool: add/sub/mul/div over two numbers.',
    axes: {
      purity: { shape: 'flag', enabled: true },
      operations: { shape: 'options', offered: Object.keys(OPS) },
      streaming: { shape: 'flag', enabled: false },
    },
    experimental: {},
    extensions: {
      'dev.kyxo.tool-schema': {
        input: { op: 'add|sub|mul|div', a: 'number', b: 'number' },
        output: { value: 'number' },
      },
    },
  },

  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as CalcRequest;
    const fn = OPS[req.op ?? ''];
    if (!fn || !Number.isFinite(req.a) || !Number.isFinite(req.b)) {
      yield { op: 'fail', error: `calculator: bad request ${JSON.stringify(request)} (want {op:add|sub|mul|div, a, b})` };
      return;
    }
    if (req.op === 'div' && req.b === 0) {
      yield { op: 'fail', error: 'calculator: division by zero' };
      return;
    }
    const value = fn(req.a as number, req.b as number);
    yield { op: 'result', output: { value, expression: `${req.op}(${req.a},${req.b})` } };
  },

  async probe(ctx) {
    const ok = OPS['add']?.(2, 2) === 4 && OPS['mul']?.(3, 3) === 9;
    return { capabilityId: 'calculator', ok, evidence: { probedAt: ctx.clock(), operations: Object.keys(OPS), selfTest: ok ? '2+2=4, 3*3=9' : 'FAILED' } };
  },
};
