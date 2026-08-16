/**
 * remote-a2a-agent.ts — an opaque remote agent behind a simulated network,
 * with an A2A-shaped task lifecycle including an input-required round trip.
 * CHEATS: "network" = a 2ms timer; the "remote side" task store is process-
 * local (in real A2A the REMOTE runtime persists the task — after a local
 * restart, resume works because the suspension payload carries the task id
 * and this mock rebuilds remote state from it).
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface A2aRequest { readonly task?: string }

/** The simulated remote side: task id -> remote task record. */
const REMOTE_TASKS = new Map<string, { task: string; phase: string }>();

const network = async (): Promise<void> => new Promise((r) => setTimeout(r, 2));

export const remoteA2aAgent: CapabilityProvider = {
  identity: { id: 'remote-a2a', version: '1.4.0', stability: 'stable' },
  manifest: {
    identity: { id: 'remote-a2a', version: '1.4.0', stability: 'stable' },
    summary: 'Opaque remote agent (A2A task lifecycle) over a simulated network.',
    axes: {
      sessionModel: { shape: 'options', offered: ['a2a-task'] },
      statefulness: { shape: 'tiered', tier: 'task', ladder: ['stateless', 'task', 'session'] },
      streaming: { shape: 'flag', enabled: false },
      errorSemantics: { shape: 'options', offered: ['a2a-task-status'] },
    },
    experimental: { pushNotifications: false },
    extensions: { 'org.a2aproject.card': { url: 'https://remote.example/.well-known/agent.json', opaque: true } },
  },

  async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as A2aRequest;
    if (ctx.resume === undefined) {
      // fresh task: remote asks a clarifying question -> input-required
      yield { op: 'progress', note: 'dialing remote runtime (simulated 2ms network)' };
      await network();
      const taskId = `remote-task-${ctx.invocationId}`;
      REMOTE_TASKS.set(taskId, { task: req.task ?? '(none)', phase: 'input-required' });
      yield { op: 'charge', cost: { moneyCents: 2 }, note: 'remote egress' };
      yield {
        op: 'suspend', reason: 'input-required',
        payload: { taskId, question: 'Remote agent asks: metric or imperial units?', expects: { units: 'metric|imperial' } },
      };
      return;
    }
    // resumed: forward the answer to the "remote" side and finish the task
    const susp = ctx.resume.suspension.payload as { taskId: string };
    const answer = (ctx.resume.input ?? {}) as { units?: string };
    await network();
    const remote = REMOTE_TASKS.get(susp.taskId) ?? { task: req.task ?? '(reconstructed)', phase: 'input-required' };
    remote.phase = 'completed';
    yield { op: 'progress', note: `remote task ${susp.taskId} resumed with units=${answer.units ?? '?'}` };
    yield { op: 'charge', cost: { moneyCents: 2 }, note: 'remote egress' };
    // remote output is untrusted: taint it and let the label propagate
    yield { op: 'artifact', content: { report: `${remote.task}: 42km shipped`, units: answer.units }, taint: ['remote:untrusted'], label: 'a2a-result' };
    yield { op: 'result', output: { taskId: susp.taskId, taskState: 'completed', report: `${remote.task} (${answer.units ?? 'metric'})` } };
  },
};
