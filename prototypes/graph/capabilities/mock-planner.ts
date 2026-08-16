/**
 * mock-planner.ts — a planner as a plain capability (spine §2: "Planner —
 * any capability that emits Plan artifacts. Not a kernel component.").
 *
 * CHEAT: the "planning" is scripted. Plan v1 is a fixed 4-node topology
 * (two parallel gathers -> join tally -> verification gate); replanning is a
 * deterministic mutation rule (insert a fix-up node in front of the gate).
 * A real planner would be model-backed; the CONTRACT — objective in, Plan
 * artifact out, evidence-driven mutation with basedOn/becauseOf provenance —
 * is what is being validated.
 */
import { createHash } from 'node:crypto';

import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../../kernel/types.ts';
import { PLAN_KIND } from '../plan-kind.ts';
import type { Plan, PlanNode } from '../plan-kind.ts';

interface PlannerRequest {
  readonly objective?: string;
  readonly priorPlan?: Plan;
  readonly priorPlanArtifact?: string;
  readonly evidence?: { readonly hash: string; readonly problems: readonly string[] };
}

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

function planV1(objective: string): Plan {
  return {
    planId: `plan-${shortHash(objective)}`,
    version: 1,
    objective,
    gate: 'verify',
    nodes: [
      {
        id: 'gather-archive',
        requires: [
          { axis: 'gathering', need: 'tier-at-least', tier: 'deep' },
          { axis: 'dataFormat', need: 'one-of', anyOf: ['records'] },
        ],
        input: { objective: { from: 'objective' }, window: { from: 'const', value: 'last-90-days' } },
      },
      {
        id: 'gather-live',
        requires: [
          { axis: 'freshness', need: 'tier-at-least', tier: 'live' },
          { axis: 'dataFormat', need: 'one-of', anyOf: ['records'] },
        ],
        input: { objective: { from: 'objective' }, sweep: { from: 'const', value: 'full-sector' } },
      },
      {
        id: 'join-tally',
        join: { policy: 'all' },
        requires: [{ axis: 'aggregation', need: 'enabled' }],
        input: {
          objective: { from: 'objective' },
          archive: { from: 'node', node: 'gather-archive' },
          live: { from: 'node', node: 'gather-live' },
        },
      },
      {
        id: 'verify',
        requires: [{ axis: 'verification', need: 'one-of', anyOf: ['report-consistency'] }],
        input: { report: { from: 'node', node: 'join-tally' } },
      },
    ],
    edges: [
      { from: 'gather-archive', to: 'join-tally' },
      { from: 'gather-live', to: 'join-tally' },
      { from: 'join-tally', to: 'verify' },
    ],
  };
}

/** Mutation rule: keep everything, insert a fix-up node between the gate's
 *  feed and the gate, rewire the gate to consume the fixed-up report, and
 *  stamp the new version with basedOn + becauseOf provenance. */
function mutate(prior: Plan, priorArtifact: string, evidence: { readonly hash: string; readonly problems: readonly string[] }): Plan | string {
  const gateNode = prior.nodes.find((n) => n.id === prior.gate);
  const feedEdge = prior.edges.find((e) => e.to === prior.gate);
  if (gateNode === undefined || feedEdge === undefined) return `prior plan v${prior.version} has no wired gate to mutate around`;
  const FIX = 'fixup-reconcile';
  const fixup: PlanNode = {
    id: FIX,
    requires: [{ axis: 'reconciliation', need: 'enabled' }],
    input: {
      report: { from: 'node', node: feedEdge.from },
      problems: { from: 'const', value: evidence.problems },
      evidence: { from: 'artifact', hash: evidence.hash },
    },
  };
  return {
    ...prior,
    version: prior.version + 1,
    basedOn: priorArtifact,
    becauseOf: [evidence.hash],
    nodes: [
      ...prior.nodes.filter((n) => n.id !== prior.gate),
      fixup,
      { ...gateNode, input: { report: { from: 'node', node: FIX } } },
    ],
    edges: [
      ...prior.edges.filter((e) => e.to !== prior.gate),
      { from: feedEdge.from, to: FIX },
      { from: FIX, to: prior.gate, when: { path: 'reconciled', equals: true } },
    ],
  };
}

export const mockPlanner: CapabilityProvider = {
  identity: { id: 'mock-planner', version: '0.3.0', stability: 'testing' },
  manifest: {
    identity: { id: 'mock-planner', version: '0.3.0', stability: 'testing' },
    summary: 'Scripted planner: emits Plan artifacts; mutates plans against verification evidence.',
    axes: {
      plans: { shape: 'options', offered: [PLAN_KIND] },
      replanning: { shape: 'flag', enabled: true },
      planning: { shape: 'tiered', tier: 'adaptive', ladder: ['template', 'adaptive'] },
    },
    experimental: { scripted: true },
    extensions: { 'dev.kyxo.planner': { mutationRule: 'insert-fixup-before-gate' } },
  },

  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as PlannerRequest;
    const objective = req.objective ?? '';
    if (objective === '') { yield { op: 'fail', error: 'mock-planner: objective required' }; return; }
    if (req.evidence === undefined) {
      yield { op: 'progress', note: 'drafting plan v1: two parallel gathers -> join tally -> verification gate' };
      yield { op: 'charge', cost: { tokens: 180, moneyCents: 2 }, note: 'planning tokens' };
      yield { op: 'result', output: planV1(objective) };
      return;
    }
    if (req.priorPlan === undefined || req.priorPlanArtifact === undefined || req.priorPlanArtifact === '') {
      yield { op: 'fail', error: 'mock-planner: replanning requires priorPlan + priorPlanArtifact' };
      return;
    }
    yield { op: 'progress', note: `mutating plan v${req.priorPlan.version} against evidence ${req.evidence.hash}: inserting fix-up node before the gate` };
    yield { op: 'charge', cost: { tokens: 160, moneyCents: 2 }, note: 'replanning tokens' };
    const next = mutate(req.priorPlan, req.priorPlanArtifact, req.evidence);
    if (typeof next === 'string') { yield { op: 'fail', error: `mock-planner: ${next}` }; return; }
    yield { op: 'result', output: next };
  },
};
