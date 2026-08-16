/**
 * gatherers.ts — two data-gathering capabilities with DIFFERENT tiers on the
 * SAME axes. Neither is named in any plan: plan nodes carry axis
 * requirements and the strategy resolves winners at execution time
 * (archive-scanner wins gathering>=deep; live-probe wins freshness>=live —
 * each is REJECTED at bind time for the other's requirement).
 *
 * Both sleep between progress yields so the parallel fan-out visibly
 * interleaves in the journal.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../../kernel/types.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface GatherRequest { readonly objective?: string }

export const archiveScanner: CapabilityProvider = {
  identity: { id: 'archive-scanner', version: '1.0.0', stability: 'stable' },
  manifest: {
    identity: { id: 'archive-scanner', version: '1.0.0', stability: 'stable' },
    summary: 'Deep scan of archived beacon registration records (thorough, not fresh).',
    axes: {
      gathering: { shape: 'tiered', tier: 'deep', ladder: ['shallow', 'deep'] },
      freshness: { shape: 'tiered', tier: 'archived', ladder: ['archived', 'live'] },
      dataFormat: { shape: 'options', offered: ['records'] },
    },
    experimental: {},
    extensions: {},
  },
  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const objective = ((request ?? {}) as GatherRequest).objective ?? '(none)';
    for (let shard = 1; shard <= 3; shard++) {
      await sleep(6);
      yield { op: 'progress', note: `archive shard ${shard}/3 scanned` };
    }
    yield { op: 'charge', cost: { tokens: 40 }, note: 'archive scan' };
    yield {
      op: 'result',
      output: { source: 'archive-scanner', count: 12, basis: `12 beacon registrations on record (objective: ${objective})`, ok: true },
    };
  },
};

export const liveProbe: CapabilityProvider = {
  identity: { id: 'live-probe', version: '1.1.0', stability: 'stable' },
  manifest: {
    identity: { id: 'live-probe', version: '1.1.0', stability: 'stable' },
    summary: 'Live ping sweep across sector relays (fresh, not deep).',
    axes: {
      gathering: { shape: 'tiered', tier: 'shallow', ladder: ['shallow', 'deep'] },
      freshness: { shape: 'tiered', tier: 'live', ladder: ['archived', 'live'] },
      dataFormat: { shape: 'options', offered: ['records'] },
    },
    experimental: {},
    extensions: {},
  },
  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const objective = ((request ?? {}) as GatherRequest).objective ?? '(none)';
    for (let relay = 1; relay <= 3; relay++) {
      await sleep(9);
      yield { op: 'progress', note: `relay ${relay}/3 pinged` };
    }
    yield { op: 'charge', cost: { tokens: 30 }, note: 'live sweep' };
    yield {
      op: 'result',
      output: { source: 'live-probe', count: 9, basis: `9 beacons answered the live sweep (objective: ${objective})`, ok: true },
    };
  },
};
