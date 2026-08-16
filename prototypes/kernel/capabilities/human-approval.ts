/**
 * human-approval.ts — a human as a capability (spine §5): elicitation-shaped
 * contract, typed suspension payload (suspend/resume schema pattern), and
 * responsibility metadata in the manifest extension — never an anonymous tool.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface ApprovalRequest { readonly action?: string; readonly riskNote?: string }
interface Decision { readonly decision?: string; readonly note?: string }

export const humanApproval: CapabilityProvider = {
  identity: { id: 'human-approval', version: '1.0.0', stability: 'stable' },
  manifest: {
    identity: { id: 'human-approval', version: '1.0.0', stability: 'stable' },
    summary: 'Human approver behind a typed form elicitation; suspends until decided.',
    axes: {
      elicitation: { shape: 'options', offered: ['form'] },
      responsiveness: { shape: 'tiered', tier: 'async', ladder: ['async', 'realtime'] },
      streaming: { shape: 'flag', enabled: false },
    },
    experimental: { escalationPolicy: 'none (prototype)' },
    extensions: {
      'dev.kyxo.responsibility': { approverRole: 'research-lead', consentRecorded: true, deadline: 'PT24H' },
    },
  },

  async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as ApprovalRequest;
    if (ctx.resume === undefined) {
      // typed suspension: the payload IS the form (suspendSchema), and it
      // declares the resume shape (resumeSchema) the caller must supply.
      yield {
        op: 'suspend', reason: 'approval-required',
        payload: {
          form: { question: `Approve action: ${req.action ?? '(unspecified)'}?`, riskNote: req.riskNote ?? '', options: ['approve', 'reject'] },
          resumeSchema: { decision: "'approve' | 'reject'", note: 'string (optional)' },
        },
      };
      return;
    }
    const d = (ctx.resume.input ?? {}) as Decision;
    yield { op: 'charge', cost: { invocations: 0, moneyCents: 0, tokens: 0 }, note: 'humans are expensive but not in these units' };
    if (d.decision === 'approve') {
      yield { op: 'artifact', content: { decidedBy: 'research-lead', decision: 'approve', note: d.note ?? '' }, label: 'approval-record' };
      yield { op: 'result', output: { approved: true, decidedBy: 'research-lead', note: d.note ?? '' } };
      return;
    }
    yield { op: 'fail', error: `human rejected: ${d.note ?? '(no reason given)'}` };
  },
};
