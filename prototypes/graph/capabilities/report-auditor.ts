/**
 * report-auditor.ts — a verifier as a plain capability (spine §5:
 * "Verifiers ... are capabilities"). A failing verdict is NOT an invocation
 * failure: the invocation completes and its output artifact IS the Evidence
 * that drives replanning.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../../kernel/types.ts';

interface Report {
  readonly archiveCount?: number;
  readonly liveCount?: number;
  readonly discrepancy?: number;
  readonly reconciled?: boolean;
  readonly discrepancyExplained?: boolean;
  readonly sources?: readonly string[];
}
interface AuditRequest { readonly report?: Report }

export const reportAuditor: CapabilityProvider = {
  identity: { id: 'report-auditor', version: '2.0.0', stability: 'stable' },
  manifest: {
    identity: { id: 'report-auditor', version: '2.0.0', stability: 'stable' },
    summary: 'Audits tally reports for cross-source consistency; emits pass/fail Evidence.',
    axes: {
      verification: { shape: 'options', offered: ['report-consistency'] },
      rigor: { shape: 'tiered', tier: 'strict', ladder: ['lenient', 'strict'] },
    },
    experimental: {},
    extensions: {},
  },
  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const r = ((request ?? {}) as AuditRequest).report ?? {};
    const problems: string[] = [];
    if (r.reconciled !== true) {
      problems.push(`report not reconciled: sources [${(r.sources ?? []).join(', ')}] were tallied but never cross-checked`);
    }
    if ((r.discrepancy ?? 0) !== 0 && r.discrepancyExplained !== true) {
      problems.push(`source disagreement unexplained: archive=${r.archiveCount ?? '?'} live=${r.liveCount ?? '?'} (discrepancy ${r.discrepancy ?? '?'})`);
    }
    yield { op: 'progress', note: `audit rule report-consistency@strict found ${problems.length} problem(s)` };
    yield { op: 'charge', cost: { tokens: 15 }, note: 'audit' };
    yield { op: 'result', output: { verdict: problems.length === 0 ? 'pass' : 'fail', problems, rule: 'report-consistency@strict' } };
  },
};
