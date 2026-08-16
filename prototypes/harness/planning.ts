/**
 * planning.ts — PlanningHarness: plan-then-execute as a behaviour.
 *
 * Strategy: the first turn asks the model for a Plan; the plan is validated
 * and stored as a REGISTERED KIND object (dev.kyxo.harness/Plan — the CRD
 * move: the "Plan" concept arrives without any kernel change). Subsequent
 * turns execute plan steps through the tool binding. On a failed step the
 * harness replans ONCE (a new Plan version superseding the old), then
 * terminates when the plan is complete.
 *
 * verify IS implemented: it independently recomputes every executed step and
 * stores an Evidence artifact whose provenance links the candidate output
 * and every Plan version consumed.
 */

import type { KindDefinition } from '../kernel/types.ts';
import type {
  ActIntent, CompiledContext, ContinuationDecision, HarnessBehaviour, HarnessCtx,
  LoopSignals, Observation,
} from './behaviour.ts';

// ---------------------------------------------------------------------------
// The Plan Kind (registered by the demo; validated by the kernel on store)
// ---------------------------------------------------------------------------

export const PLAN_KIND_NAME = 'dev.kyxo.harness/Plan';

export const planKind: KindDefinition = {
  name: PLAN_KIND_NAME, version: 'v1',
  validate: (p) => {
    const o = p as { title?: unknown; version?: unknown; steps?: unknown; supersedes?: unknown } | null;
    if (o === null || typeof o !== 'object') return ['payload must be an object'];
    const errs: string[] = [];
    if (typeof o.title !== 'string' || o.title === '') errs.push('title: non-empty string required');
    if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) errs.push('version: positive integer >= 1 required');
    if (!Array.isArray(o.steps) || o.steps.length === 0) errs.push('steps: non-empty array required');
    else {
      for (const [i, raw] of (o.steps as unknown[]).entries()) {
        const s = raw as { op?: unknown; a?: unknown; b?: unknown } | null;
        if (s === null || typeof s !== 'object') { errs.push(`steps[${i}]: object required`); continue; }
        if (typeof s.op !== 'string' || s.op === '') errs.push(`steps[${i}].op: non-empty string required`);
        if (typeof s.a !== 'number' || !Number.isFinite(s.a)) errs.push(`steps[${i}].a: finite number required`);
        if (typeof s.b !== 'number' || !Number.isFinite(s.b)) errs.push(`steps[${i}].b: finite number required`);
      }
    }
    if (o.supersedes !== null && o.supersedes !== undefined && typeof o.supersedes !== 'string') {
      errs.push('supersedes: string | null required');
    }
    return errs;
  },
};

// ---------------------------------------------------------------------------
// The behaviour
// ---------------------------------------------------------------------------

interface PlanStep { readonly op: string; readonly a: number; readonly b: number; readonly note?: string }
interface ModelOut { readonly text?: string; readonly plan?: { readonly title: string; readonly steps: readonly PlanStep[] } }
interface StepResult { readonly op: string; readonly a: number; readonly b: number; readonly value: number }

type Phase = 'plan' | 'execute' | 'replan' | 'done' | 'stuck';

interface PlanningState {
  readonly phase: Phase;
  readonly steps: readonly PlanStep[];
  readonly cursor: number;
  readonly results: readonly StepResult[];
  readonly planVersion: number;
  readonly planArtifacts: readonly string[];
  readonly failedStep: PlanStep | undefined;
  readonly lastFailure: string | undefined;
  readonly replansUsed: number;
}

export interface PlanningConfig {
  readonly model: string;
  readonly session: string;
  readonly tool: string;
}

const stepLabel = (s: PlanStep): string => `${s.op}(${s.a},${s.b})`;

export function makePlanningHarness(cfg: PlanningConfig): HarnessBehaviour<PlanningState> {
  return {
    id: 'planning-harness',
    version: '0.1.0',
    summary: 'plan-then-execute; Plan is a registered Kind; replans once on a failed step; terminates on plan complete',
    needs: [
      {
        alias: 'model', capabilityId: cfg.model, role: 'model', requirements: [
          { axis: 'toolDialect', need: 'one-of', anyOf: ['kyxo-json'] },
          { axis: 'session', need: 'one-of', anyOf: [cfg.session] },
          { axis: 'structuredOutput', need: 'tier-at-least', tier: 'json' },
        ],
      },
      {
        alias: 'tool', capabilityId: cfg.tool, role: 'tool', requirements: [
          { axis: 'operations', need: 'present' },
        ],
      },
    ],

    init: (): PlanningState => ({
      phase: 'plan', steps: [], cursor: 0, results: [], planVersion: 0,
      planArtifacts: [], failedStep: undefined, lastFailure: undefined, replansUsed: 0,
    }),

    compileContext: (ctx: HarnessCtx, s): CompiledContext => {
      let prompt: string;
      let sources: readonly string[];
      if (s.phase === 'plan') {
        prompt = [
          'PLAN-REQUEST',
          `OBJECTIVE: ${ctx.objective}`,
          'TOOLS: calculator ops add|sub|mul|div over (a,b)',
          'Respond with an ordered plan of calculator steps that fulfils the objective.',
        ].join('\n');
        sources = ['objective', 'tool-manifest'];
      } else if (s.phase === 'replan') {
        prompt = [
          'REPLAN-REQUEST',
          `OBJECTIVE: ${ctx.objective}`,
          `COMPLETED-SO-FAR: ${s.results.map((r) => `${r.op}(${r.a},${r.b}) = ${r.value}`).join('; ') || '(nothing)'}`,
          `FAILED-STEP: ${s.failedStep !== undefined ? stepLabel(s.failedStep) : '(unknown)'}`,
          `ERROR: ${s.lastFailure ?? '(none recorded)'}`,
          'Propose a corrected plan for the remaining work only.',
        ].join('\n');
        sources = ['objective', 'plan-results', 'failure'];
      } else {
        prompt = `PLAN-EXECUTION v${s.planVersion}: step ${s.cursor + 1}/${s.steps.length}`;
        sources = ['plan', 'plan-results'];
      }
      return { prompt, sources, tokenEstimate: Math.ceil(prompt.length / 4) };
    },

    act: (_ctx, s, view): ActIntent => {
      if (s.phase === 'plan' || s.phase === 'replan') {
        return {
          binding: 'model',
          request: { session: cfg.session, prompt: view.prompt },
          note: s.phase === 'plan' ? 'ask model for a plan' : 'ask model to replan after failed step',
        };
      }
      if (s.phase === 'execute') {
        const step = s.steps[s.cursor];
        if (step === undefined) throw new Error(`planning: cursor ${s.cursor} out of range (${s.steps.length} steps)`);
        return {
          binding: 'tool',
          request: { op: step.op, a: step.a, b: step.b },
          note: `plan v${s.planVersion} step ${s.cursor + 1}/${s.steps.length}: ${stepLabel(step)}`,
        };
      }
      throw new Error(`planning: act() called in terminal phase '${s.phase}' — driver/behaviour contract violation`);
    },

    integrateObservation: (ctx: HarnessCtx, s, obs: Observation): PlanningState => {
      if (obs.kind === 'model-reply') {
        const out = obs.output as ModelOut;
        if (out.plan === undefined || out.plan.steps.length === 0) {
          return { ...s, phase: 'stuck', lastFailure: 'model reply contained no plan' };
        }
        const version = s.planVersion + 1;
        // The Plan is a registered Kind: schema-validated by the kernel, stored
        // as a content-addressed artifact, journaled as kind.object.
        const hash = ctx.createKindObject(PLAN_KIND_NAME, {
          title: out.plan.title,
          version,
          objective: ctx.objective,
          steps: out.plan.steps,
          supersedes: s.planArtifacts.at(-1) ?? null,
        });
        return {
          ...s, phase: 'execute', steps: out.plan.steps, cursor: 0, planVersion: version,
          planArtifacts: [...s.planArtifacts, hash], failedStep: undefined, lastFailure: undefined,
        };
      }
      if (obs.kind === 'tool-result') {
        const step = s.steps[s.cursor];
        const value = (obs.output as { value: number }).value;
        const results = step !== undefined
          ? [...s.results, { op: step.op, a: step.a, b: step.b, value }]
          : s.results;
        const cursor = s.cursor + 1;
        return { ...s, results, cursor, phase: cursor >= s.steps.length ? 'done' : 'execute' };
      }
      // invocation-trouble
      if (s.phase === 'execute' && s.replansUsed === 0) {
        return {
          ...s, phase: 'replan', replansUsed: 1,
          failedStep: s.steps[s.cursor], lastFailure: obs.error,
        };
      }
      return { ...s, phase: 'stuck', lastFailure: obs.error };
    },

    decideContinuation: (_ctx, s, signals: LoopSignals): ContinuationDecision => {
      if (s.phase === 'done') {
        const final = s.results.at(-1);
        return {
          kind: 'finalize',
          output: {
            answer: `${s.results.map((r) => `${r.op}(${r.a},${r.b})=${r.value}`).join(', ')} -> final value ${final?.value ?? NaN}`,
            value: final?.value ?? NaN,
            planVersions: s.planVersion,
            stepsExecuted: s.results.length,
          },
        };
      }
      if (s.phase === 'stuck') {
        return { kind: 'fail', error: `planning: stuck (${s.lastFailure ?? 'unknown failure'}) after ${s.replansUsed} replan(s)` };
      }
      if (signals.failureStreak >= 3) {
        return { kind: 'fail', error: `planning: ${signals.failureStreak} consecutive failed invocations` };
      }
      return { kind: 'continue' };
    },

    /** Independent recompute of every executed step + plan-completeness check,
     *  stored as an Evidence artifact with provenance into the candidate and
     *  every Plan version. (The kernel has no commit gate to enforce this yet
     *  — see findings.) */
    verify: (ctx: HarnessCtx, s, candidateArtifact: string): readonly string[] => {
      const RECOMPUTE: Readonly<Record<string, (a: number, b: number) => number>> = {
        add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b,
      };
      const checks = s.results.map((r) => {
        const fn = RECOMPUTE[r.op];
        const recomputed = fn === undefined ? Number.NaN : fn(r.a, r.b);
        return { expression: `${r.op}(${r.a},${r.b})`, reported: r.value, recomputed, ok: recomputed === r.value };
      });
      const verdict = s.phase === 'done' && checks.length > 0 && checks.every((c) => c.ok) ? 'pass' : 'fail';
      const hash = ctx.storeArtifact(
        {
          kind: 'Evidence',
          verifier: 'independent-recompute+plan-completeness',
          candidate: candidateArtifact,
          planArtifacts: s.planArtifacts,
          checks,
          planComplete: s.phase === 'done',
          verdict,
        },
        { inputs: [candidateArtifact, ...s.planArtifacts] },
      );
      return [hash];
    },
  };
}
