/**
 * graph-strategy.ts — the dynamic-graph orchestration strategy: a plain
 * capability (spine §1/§5: graphs are strategies, NOT kernel material) that
 *
 *   1. resolves a PLANNER by capability requirement and asks it for Plan v1,
 *   2. executes the plan in BSP-style waves — per-node requirement->binding
 *      resolution AT EXECUTION TIME, parallel fan-out, explicit join
 *      barriers, edge conditions evaluated on upstream outputs,
 *   3. reads the gate node's verdict: on verification failure it hands the
 *      planner the Evidence artifact and requires a MUTATED plan whose
 *      provenance (basedOn/becauseOf + artifact inputs) links to that
 *      evidence — an unaccountable mutation is refused,
 *   4. re-executes the new version: unchanged nodes are memoized through
 *      deterministic idempotency keys (uuid5-style identity, spine §5), so
 *      only the delta actually runs — and only the delta is charged.
 *
 * Resolution is by TRIAL NEGOTIATION: candidates are enumerated via the
 * kernel discovery hook and bound in registration order; every loser leaves
 * a `binding.rejected` journal record carrying the exact negotiation
 * problems, so "why did this provider win" is answerable from the truth
 * plane. The kernel itself never sees a node, an edge, or a plan — only
 * bindings, invocations, artifacts, grants.
 */
import { createHash } from 'node:crypto';

import type {
  AxisRequirement, CapabilityEvent, CapabilityProvider, Grant, InvocationOutcome,
  InvokeCtx, KernelApi,
} from '../kernel/types.ts';
import { PLAN_KIND, validatePlan } from './plan-kind.ts';
import type { Plan, PlanEdge, PlanNode } from './plan-kind.ts';

// ---------------------------------------------------------------------------
// Public record types (returned in the strategy's result for inspection)
// ---------------------------------------------------------------------------

export interface CandidateVerdict {
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface Resolution {
  readonly bindingId: string;
  readonly winner: string;
  readonly negotiated: Readonly<Record<string, string | boolean>>;
  readonly considered: readonly CandidateVerdict[];
}

export interface NodeRunRecord {
  readonly nodeId: string;
  readonly winner: string;
  readonly negotiated: Readonly<Record<string, string | boolean>>;
  readonly rejected: readonly CandidateVerdict[];
  readonly invocationId: string;
  readonly memoized: boolean;
  readonly outputArtifact: string | undefined;
}

export interface EdgeConditionCheck {
  readonly from: string;
  readonly to: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface PlanExecutionRecord {
  readonly planVersion: number;
  readonly waves: readonly (readonly string[])[];
  readonly runs: readonly NodeRunRecord[];
  readonly conditions: readonly EdgeConditionCheck[];
  readonly skipped: readonly string[];
}

export interface PlanLineageEntry {
  readonly version: number;
  readonly artifact: string;
  readonly basedOn: string | undefined;
  readonly becauseOf: readonly string[];
  readonly producedByInvocation: string;
}

export interface VerdictRecord {
  readonly planVersion: number;
  readonly verdict: string;
  readonly problems: readonly string[];
  readonly evidenceArtifact: string | undefined;
  readonly verifierInvocationId: string;
}

export interface GraphRunOutput {
  readonly objective: string;
  readonly plannerCapability: string;
  readonly lineage: readonly PlanLineageEntry[];
  readonly executions: readonly PlanExecutionRecord[];
  readonly verdicts: readonly VerdictRecord[];
  readonly finalReport: unknown;
  readonly childGrantId: string;
}

// ---------------------------------------------------------------------------
// Requirement -> Binding resolution (execution-time, trial negotiation)
// ---------------------------------------------------------------------------

export function fmtRequirement(r: AxisRequirement): string {
  if (r.need === 'tier-at-least') return `${r.axis}>=${r.tier}`;
  if (r.need === 'one-of') return `${r.axis} in {${r.anyOf.join('|')}}`;
  if (r.need === 'enabled') return `${r.axis}=on`;
  return `${r.axis} present`;
}

/** Extract the negotiation problems from a loud BindError message. */
function bindFailureDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const marker = msg.indexOf(':\n');
  if (marker < 0) return msg;
  return msg.slice(marker + 2).split('\n').map((l) => l.replace(/^\s*-\s*/, '')).join('; ');
}

/** First-fit trial negotiation over the discovered registry. Every rejected
 *  candidate is recorded (and journaled by the kernel as binding.rejected). */
export function resolveRequirement(kernel: KernelApi, grantId: string, requires: readonly AxisRequirement[]): Resolution {
  const considered: CandidateVerdict[] = [];
  for (const manifest of kernel.listCapabilities()) {
    const id = manifest.identity.id;
    try {
      const binding = kernel.bind({ capabilityId: id, grantId, requirements: requires });
      considered.push({ capabilityId: id, ok: true, detail: `negotiated ${JSON.stringify(binding.negotiated)}` });
      return { bindingId: binding.id, winner: id, negotiated: binding.negotiated, considered };
    } catch (err) {
      considered.push({ capabilityId: id, ok: false, detail: bindFailureDetail(err) });
    }
  }
  throw new Error(
    `no registered capability satisfies [${requires.map(fmtRequirement).join(', ')}]:\n` +
    considered.map((c) => `  - ${c.capabilityId}: ${c.detail}`).join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

function pathGet(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const incoming = (plan: Plan, nodeId: string): readonly PlanEdge[] => plan.edges.filter((e) => e.to === nodeId);

interface BuiltInput { readonly request: Record<string, unknown>; readonly inputArtifacts: readonly string[] }

function buildInput(node: PlanNode, objective: string, done: ReadonlyMap<string, InvocationOutcome>): BuiltInput {
  const request: Record<string, unknown> = {};
  const inputArtifacts: string[] = [];
  for (const [key, src] of Object.entries(node.input)) {
    if (src.from === 'objective') { request[key] = objective; continue; }
    if (src.from === 'const') { request[key] = src.value; continue; }
    if (src.from === 'artifact') { request[key] = { artifactRef: src.hash }; inputArtifacts.push(src.hash); continue; }
    const up = done.get(src.node);
    if (up === undefined) throw new Error(`input '${key}' needs output of node '${src.node}' which has not completed`);
    request[key] = src.path === undefined ? up.output : pathGet(up.output, src.path);
    if (up.outputArtifact !== undefined) inputArtifacts.push(up.outputArtifact);
  }
  return { request, inputArtifacts };
}

interface Launch {
  readonly node: PlanNode;
  readonly resolution: Resolution;
  readonly request: Record<string, unknown>;
  readonly inputArtifacts: readonly string[];
  readonly idemKey: string;
  readonly memoized: boolean;
}

interface GraphRequest { readonly objective?: string; readonly maxPlanVersions?: number }

const PLANNER_REQUIRES: readonly AxisRequirement[] = [
  { axis: 'plans', need: 'one-of', anyOf: [PLAN_KIND] },
  { axis: 'replanning', need: 'enabled' },
];

// ---------------------------------------------------------------------------
// The strategy
// ---------------------------------------------------------------------------

export function makeDynamicGraphStrategy(): CapabilityProvider {
  const identity = { id: 'dynamic-graph', version: '0.1.0', stability: 'experimental' } as const;
  return {
    identity,
    manifest: {
      identity,
      summary: 'Dynamic-graph strategy: plan, resolve-by-requirement, fan-out/join, verify, mutate, re-execute delta.',
      axes: {
        parallelism: { shape: 'tiered', tier: 'fan-out', ladder: ['sequential', 'fan-out'] },
        planning: { shape: 'tiered', tier: 'replanning', ladder: ['static', 'replanning'] },
        verificationGate: { shape: 'flag', enabled: true },
        planDialect: { shape: 'options', offered: [PLAN_KIND] },
      },
      experimental: { joinPolicies: ['all'] },
      extensions: {
        'dev.kyxo.graph': { resolution: 'requirement-trial-bind', memoization: 'deterministic-idempotency-key' },
      },
    },

    async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
      const req = (request ?? {}) as GraphRequest;
      const objective = req.objective ?? '';
      if (objective === '') { yield { op: 'fail', error: 'dynamic-graph: objective required' }; return; }
      const maxVersions = req.maxPlanVersions ?? 3;

      // Attenuated delegation: everything below runs under a strictly
      // smaller grant; all charges flow up the lineage.
      let child: Grant;
      try {
        child = ctx.kernel.attenuate(ctx.grantId, {
          rights: ['invoke:*'],
          budgets: { tokens: 2500, moneyCents: 100, invocations: 25, spawnDepth: 2 },
          label: `dynamic-graph child of ${ctx.grantId}`,
        });
      } catch (err) {
        yield { op: 'fail', error: `dynamic-graph: attenuation refused: ${err instanceof Error ? err.message : String(err)}` };
        return;
      }
      yield { op: 'progress', note: `attenuated child grant ${child.id} (tokens 2500, invocations 25, spawnDepth 2)` };

      // The planner itself is resolved by requirement — nothing is hardcoded.
      let plannerRes: Resolution;
      try {
        plannerRes = resolveRequirement(ctx.kernel, child.id, PLANNER_REQUIRES);
      } catch (err) {
        yield { op: 'fail', error: `dynamic-graph: planner resolution failed: ${err instanceof Error ? err.message : String(err)}` };
        return;
      }
      yield {
        op: 'progress',
        note: `planner requirement [${PLANNER_REQUIRES.map(fmtRequirement).join(', ')}] -> '${plannerRes.winner}' after rejecting ${plannerRes.considered.length - 1} candidate(s)`,
      };

      const p1 = await ctx.kernel.invoke(plannerRes.bindingId, { objective }, { causationId: ctx.invocationId });
      if (p1.state !== 'completed' || p1.outputArtifact === undefined) {
        yield { op: 'fail', error: `dynamic-graph: planner invocation ended '${p1.state}': ${p1.error ?? ''}` };
        return;
      }
      let plan = p1.output as Plan;
      let planArtifact = p1.outputArtifact;
      let problems = validatePlan(plan);
      if (problems.length > 0) {
        yield { op: 'fail', error: `dynamic-graph: planner emitted an invalid plan:\n  - ${problems.join('\n  - ')}` };
        return;
      }
      const lineage: PlanLineageEntry[] = [{
        version: plan.version, artifact: planArtifact, basedOn: plan.basedOn,
        becauseOf: plan.becauseOf ?? [], producedByInvocation: p1.invocationId,
      }];
      yield {
        op: 'progress',
        note: `plan v${plan.version} (${plan.planId}) received as artifact ${planArtifact}: ${plan.nodes.length} nodes, ${plan.edges.length} edges, gate '${plan.gate}'`,
      };

      // Deterministic identity across plan versions: same node + same winner
      // + same input => same idempotency key => kernel memoizes.
      const invocationByKey = new Map<string, string>();
      const executions: PlanExecutionRecord[] = [];
      const verdicts: VerdictRecord[] = [];
      let finalReport: unknown;
      let passed = false;

      for (let round = 1; round <= maxVersions; round++) {
        yield { op: 'progress', note: `--- executing plan v${plan.version} ---` };
        const done = new Map<string, InvocationOutcome>();
        const skipped: string[] = [];
        const runs: NodeRunRecord[] = [];
        const conditions: EdgeConditionCheck[] = [];
        const waves: string[][] = [];

        while (done.size + skipped.length < plan.nodes.length) {
          const ready = plan.nodes.filter((n) =>
            !done.has(n.id) && !skipped.includes(n.id) &&
            incoming(plan, n.id).every((e) => done.has(e.from) || skipped.includes(e.from)));
          if (ready.length === 0) {
            yield { op: 'fail', error: `dynamic-graph: scheduling deadlock in plan v${plan.version} — remaining nodes can never become ready` };
            return;
          }
          const launches: Launch[] = [];
          for (const node of ready) {
            const inc = incoming(plan, node.id);
            let runnable = true;
            for (const e of inc) {
              if (skipped.includes(e.from)) { runnable = false; continue; }
              if (e.when !== undefined) {
                const actual = pathGet(done.get(e.from)?.output, e.when.path);
                const satisfied = actual === e.when.equals;
                conditions.push({
                  from: e.from, to: e.to, satisfied,
                  detail: `${e.when.path}=${JSON.stringify(actual)} (required ${JSON.stringify(e.when.equals)})`,
                });
                if (!satisfied) runnable = false;
              }
            }
            if (!runnable) {
              skipped.push(node.id);
              yield { op: 'progress', note: `node '${node.id}' SKIPPED (upstream skipped or edge condition unsatisfied)` };
              continue;
            }
            if (node.join !== undefined) {
              yield { op: 'progress', note: `join barrier '${node.id}' released: all ${inc.length} incoming branches settled` };
            }
            let resolution: Resolution;
            let built: BuiltInput;
            try {
              resolution = resolveRequirement(ctx.kernel, child.id, node.requires);
              built = buildInput(node, objective, done);
            } catch (err) {
              yield { op: 'fail', error: `dynamic-graph: node '${node.id}': ${err instanceof Error ? err.message : String(err)}` };
              return;
            }
            const idemKey = `graph:${plan.planId}:${node.id}:${shortHash(resolution.winner + ' ' + JSON.stringify(built.request))}`;
            const memoized = invocationByKey.has(idemKey);
            yield {
              op: 'progress',
              note: `node '${node.id}' [${node.requires.map(fmtRequirement).join(', ')}] -> '${resolution.winner}' ` +
                `(${resolution.considered.filter((c) => !c.ok).length} candidate(s) rejected)` +
                (memoized ? ' [memoized: unchanged since previous plan version]' : ''),
            };
            launches.push({ node, resolution, request: built.request, inputArtifacts: built.inputArtifacts, idemKey, memoized });
          }
          if (launches.length === 0) continue;
          waves.push(launches.map((l) => l.node.id));
          if (launches.length > 1) {
            yield { op: 'progress', note: `wave ${waves.length}: PARALLEL fan-out of [${launches.map((l) => l.node.id).join(', ')}]` };
          }
          const outcomes = await Promise.all(launches.map((l) =>
            ctx.kernel.invoke(l.resolution.bindingId, l.request, {
              causationId: ctx.invocationId, idempotencyKey: l.idemKey, inputArtifacts: l.inputArtifacts,
            })));
          for (let i = 0; i < launches.length; i++) {
            const l = launches[i] as Launch;
            const o = outcomes[i] as InvocationOutcome;
            if (o.state !== 'completed') {
              yield { op: 'fail', error: `dynamic-graph: node '${l.node.id}' ended '${o.state}': ${o.error ?? '(no error detail)'}` };
              return;
            }
            invocationByKey.set(l.idemKey, o.invocationId);
            done.set(l.node.id, o);
            runs.push({
              nodeId: l.node.id, winner: l.resolution.winner, negotiated: l.resolution.negotiated,
              rejected: l.resolution.considered.filter((c) => !c.ok),
              invocationId: o.invocationId, memoized: l.memoized, outputArtifact: o.outputArtifact,
            });
          }
        }
        executions.push({ planVersion: plan.version, waves, runs, conditions, skipped });

        // The verification gate: the plan names the node whose output is the
        // verdict; the strategy refuses to promote unverified work.
        const gate = done.get(plan.gate);
        if (gate === undefined) {
          yield { op: 'fail', error: `dynamic-graph: gate node '${plan.gate}' did not complete — refusing to promote unverified work` };
          return;
        }
        const gateOut = (gate.output ?? {}) as { verdict?: string; problems?: readonly string[] };
        const verdict = gateOut.verdict ?? '(unparseable)';
        verdicts.push({
          planVersion: plan.version, verdict, problems: gateOut.problems ?? [],
          evidenceArtifact: gate.outputArtifact, verifierInvocationId: gate.invocationId,
        });
        if (verdict === 'pass') {
          const gateNode = plan.nodes.find((n) => n.id === plan.gate) as PlanNode;
          const src = Object.values(gateNode.input).find((s) => s.from === 'node');
          finalReport = src !== undefined && src.from === 'node' ? done.get(src.node)?.output : undefined;
          passed = true;
          yield { op: 'progress', note: `verification PASSED on plan v${plan.version} — promoting result` };
          break;
        }
        yield { op: 'progress', note: `verification FAILED on plan v${plan.version}: ${(gateOut.problems ?? []).join(' | ')}` };
        if (round === maxVersions) break;

        // Mutation: replan against the Evidence artifact. The evidence hash
        // rides along as an INPUT ARTIFACT of the planner invocation, so the
        // new plan version's CAS provenance links to it structurally.
        const evidenceHash = gate.outputArtifact;
        if (evidenceHash === undefined) {
          yield { op: 'fail', error: 'dynamic-graph: verifier produced no Evidence artifact — cannot justify a mutation' };
          return;
        }
        const pn = await ctx.kernel.invoke(
          plannerRes.bindingId,
          { objective, priorPlan: plan, priorPlanArtifact: planArtifact, evidence: { hash: evidenceHash, problems: gateOut.problems ?? [] } },
          { causationId: ctx.invocationId, inputArtifacts: [evidenceHash, planArtifact] },
        );
        if (pn.state !== 'completed' || pn.outputArtifact === undefined) {
          yield { op: 'fail', error: `dynamic-graph: replanning ended '${pn.state}': ${pn.error ?? ''}` };
          return;
        }
        const next = pn.output as Plan;
        problems = validatePlan(next);
        if (problems.length > 0) {
          yield { op: 'fail', error: `dynamic-graph: planner emitted an invalid plan v${next.version}:\n  - ${problems.join('\n  - ')}` };
          return;
        }
        if (next.version !== plan.version + 1 || next.basedOn !== planArtifact || !(next.becauseOf ?? []).includes(evidenceHash)) {
          yield { op: 'fail', error: 'dynamic-graph: plan mutation is missing its provenance links (version/basedOn/becauseOf) — refusing an unaccountable mutation' };
          return;
        }
        const added = next.nodes.filter((n) => !plan.nodes.some((o) => o.id === n.id)).map((n) => n.id);
        plan = next;
        planArtifact = pn.outputArtifact;
        lineage.push({
          version: plan.version, artifact: planArtifact, basedOn: plan.basedOn,
          becauseOf: plan.becauseOf ?? [], producedByInvocation: pn.invocationId,
        });
        yield {
          op: 'progress',
          note: `plan v${plan.version} received as artifact ${planArtifact} (mutation adds [${added.join(', ')}]; basedOn=${plan.basedOn ?? '?'}; becauseOf=[${(plan.becauseOf ?? []).join(', ')}])`,
        };
      }

      if (!passed) {
        yield { op: 'fail', error: `dynamic-graph: verification still failing after ${lineage.length} plan version(s)` };
        return;
      }
      yield { op: 'artifact', content: { planId: plan.planId, lineage, verdicts }, label: 'graph-lineage' };
      const output: GraphRunOutput = {
        objective, plannerCapability: plannerRes.winner, lineage, executions, verdicts, finalReport, childGrantId: child.id,
      };
      yield { op: 'result', output };
    },
  };
}
