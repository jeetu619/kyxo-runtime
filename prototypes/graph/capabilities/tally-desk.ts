/**
 * tally-desk.ts — the aggregator behind the plan's JOIN node. It only
 * tallies; it deliberately does NOT reconcile disagreeing sources — that gap
 * is what the verification gate catches and the plan mutation fixes.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../../kernel/types.ts';

interface Source { readonly source?: string; readonly count?: number }
interface TallyRequest { readonly objective?: string; readonly archive?: Source; readonly live?: Source }

export const tallyDesk: CapabilityProvider = {
  identity: { id: 'tally-desk', version: '1.0.0', stability: 'stable' },
  manifest: {
    identity: { id: 'tally-desk', version: '1.0.0', stability: 'stable' },
    summary: 'Aggregates gathered source counts into a tally report (no reconciliation).',
    axes: {
      aggregation: { shape: 'flag', enabled: true },
      reportFormat: { shape: 'options', offered: ['tally-v1'] },
    },
    experimental: {},
    extensions: {},
  },
  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as TallyRequest;
    const a = req.archive ?? {};
    const l = req.live ?? {};
    const archiveCount = a.count ?? 0;
    const liveCount = l.count ?? 0;
    yield { op: 'progress', note: `tallying 2 sources: ${a.source ?? '?'}=${archiveCount}, ${l.source ?? '?'}=${liveCount}` };
    yield { op: 'charge', cost: { tokens: 10 }, note: 'tally' };
    yield {
      op: 'result',
      output: {
        objective: req.objective ?? '',
        archiveCount,
        liveCount,
        discrepancy: Math.abs(archiveCount - liveCount),
        reconciled: false,
        sources: [a.source ?? '?', l.source ?? '?'],
      },
    };
  },
};
