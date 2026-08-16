/**
 * bounded-loop.ts — the bounded-loop orchestration strategy (doc-10 §3;
 * mission Phase 15). An observe -> plan -> act -> verify skeleton where EVERY
 * control is declarative config (a validated LoopPolicy Kind object journaled
 * with the invocation request), never code:
 *
 *   maxIterations           hard cap on cycles; exhaustion fails loudly
 *   token budget            via the Grant the loop is bound with — the loop
 *                           yields `charge` at each iteration commit point and
 *                           the KERNEL adjudicates; exhaustion lands the loop
 *                           invocation in `budget-exceeded` (kernel-origin
 *                           typed suspension), resumable under a re-grant
 *   wallClockMs             injected-clock deadline (ctx.clock), checked at
 *                           iteration start — the kernel prototype has no
 *                           wall-clock budget dimension, so this control is
 *                           loop-enforced (see findings)
 *   stagnation              sha256 over (observation + action); `window`
 *                           identical consecutive hashes => stagnant
 *   repeated failure        M consecutive verify failures => trigger
 *   escalation ladder       rungs of model-competence tiers as DATA; a trigger
 *                           re-binds the model REQUIREMENT one tier up via
 *                           ordinary negotiation — a new Binding, journaled,
 *                           with every losing candidate's `binding.rejected`
 *                           in the truth plane
 *   human final rung        ladder exhausted => typed suspension
 *                           (`input-required`, provider origin) whose payload
 *                           carries the form, the resumeSchema, AND the full
 *                           serialized loop state — the suspension payload IS
 *                           the loop's checkpoint; resume input is guidance
 *   cancellation            free: every yield is a kernel commit point and the
 *                           kernel honors cancelRequested exactly there
 *
 * The kernel is imported UNMODIFIED from prototypes/kernel/. It never learns
 * what a "loop", "iteration", "stagnation" or "escalation" is: it sees one
 * capability invocation emitting progress/artifact/charge/suspend/result
 * events, plus child bindings and invocations for models and the verifier.
 *
 * HONEST CHEATS:
 *  - The loop charges the model-reported token usage itself (models here
 *    report usage but do not yield `charge`). This centralizes budget death
 *    on the LOOP invocation, which is what the demo wants to show; in a real
 *    runtime the model adapter charges at its own commit point and the
 *    orchestrator would need the child's budget-exceeded suspension
 *    propagated upward (a real design question — see findings).
 *  - Wall-clock restarts on human resume: time spent waiting for a human is
 *    deliberately not billed against the loop's deadline.
 *  - The model dialect (`kyxo-loop-json`: thought + action + usage) is a
 *    negotiated axis, but the loop trusts the shape after negotiation.
 */

import { createHash } from 'node:crypto';

import type {
  Binding, CapabilityEvent, CapabilityProvider, InvokeCtx, KernelApi, KindDefinition,
} from '../kernel/types.ts';

// ---------------------------------------------------------------------------
// LoopPolicy — every control, declarative. Registered as a Kind (CRD move):
// the demo validates + stores each policy as a kind.object before invoking.
// ---------------------------------------------------------------------------

export const LOOP_POLICY_KIND_NAME = 'dev.kyxo.loop/LoopPolicy';

export interface EscalationConfig {
  /** Manifest axis the ladder negotiates over (e.g. 'competence'). */
  readonly modelAxis: string;
  /** Tier per rung, low -> high. Escalation = move one rung up and re-bind. */
  readonly rungs: readonly string[];
  /** Index into rungs where the loop starts. */
  readonly startRung: number;
  readonly onStagnation: boolean;
  readonly onRepeatedFailure: boolean;
  /** Ladder exhausted => typed human suspension instead of failure. */
  readonly humanFinalRung: boolean;
}

export interface LoopPolicy {
  readonly maxIterations: number;
  /** null = no deadline. Enforced against the kernel's injected clock. */
  readonly wallClockMs: number | null;
  /** N identical consecutive (observation+action) hashes => stagnant. */
  readonly stagnationWindow: number;
  /** M consecutive verification failures => repeated-failure trigger. */
  readonly maxConsecutiveVerifyFailures: number;
  readonly escalation: EscalationConfig;
  /** Capability id of the verifier bound for the verify step. */
  readonly verifierId: string;
}

export interface LoopRequest {
  readonly objective: string;
  readonly policy: LoopPolicy;
  /** Hash of the validated LoopPolicy kind.object (provenance pin). */
  readonly policyArtifact?: string | undefined;
}

/** Shared by the Kind definition and the provider's own loud validation. */
export function policyProblems(p: unknown): readonly string[] {
  if (p === null || typeof p !== 'object') return ['policy: object required'];
  const o = p as Record<string, unknown>;
  const errs: string[] = [];
  const posInt = (k: string): void => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) errs.push(`${k}: positive integer required`);
  };
  posInt('maxIterations');
  posInt('stagnationWindow');
  posInt('maxConsecutiveVerifyFailures');
  const wc = o['wallClockMs'];
  if (wc !== null && (typeof wc !== 'number' || wc <= 0)) errs.push('wallClockMs: positive number or null required');
  if (typeof o['verifierId'] !== 'string' || o['verifierId'] === '') errs.push('verifierId: non-empty string required');
  const e = o['escalation'];
  if (e === null || e === undefined || typeof e !== 'object') { errs.push('escalation: object required'); return errs; }
  const esc = e as Record<string, unknown>;
  if (typeof esc['modelAxis'] !== 'string' || esc['modelAxis'] === '') errs.push('escalation.modelAxis: non-empty string required');
  const rungs = esc['rungs'];
  if (!Array.isArray(rungs) || rungs.length === 0 || rungs.some((r) => typeof r !== 'string' || r === '')) {
    errs.push('escalation.rungs: non-empty array of non-empty strings required');
  }
  const sr = esc['startRung'];
  if (typeof sr !== 'number' || !Number.isInteger(sr) || sr < 0 || (Array.isArray(rungs) && sr >= rungs.length)) {
    errs.push('escalation.startRung: integer index into rungs required');
  }
  for (const k of ['onStagnation', 'onRepeatedFailure', 'humanFinalRung'] as const) {
    if (typeof esc[k] !== 'boolean') errs.push(`escalation.${k}: boolean required`);
  }
  return errs;
}

export const loopPolicyKind: KindDefinition = {
  name: LOOP_POLICY_KIND_NAME,
  version: 'v1',
  validate: policyProblems,
};

// ---------------------------------------------------------------------------
// The loop's model dialect (negotiated via the `loopDialect` axis) and the
// verifier contract (negotiated via the `verdict` axis).
// ---------------------------------------------------------------------------

export type LoopAction =
  | { readonly kind: 'submit'; readonly value: number }
  | { readonly kind: 'ponder' };

export interface ModelReply {
  readonly thought: string;
  readonly action: LoopAction;
  /** Reported usage; the LOOP charges it against the grant (see header). */
  readonly usage: { readonly tokens: number };
}

export interface VerifierVerdict { readonly ok: boolean; readonly note: string }

export interface AttemptRecord {
  readonly iteration: number;
  readonly value: number;
  readonly ok: boolean;
  readonly note: string;
}

export interface EscalationRecord {
  readonly iteration: number;
  readonly trigger: 'stagnation' | 'repeated-failure';
  readonly fromTier: string;
  readonly toTier: string;
}

/** Success output of the loop invocation. */
export interface LoopResult {
  readonly answer: number;
  readonly terminationReason: 'objective-verified';
  readonly iterations: number;
  readonly tokensCharged: number;
  readonly rungPath: readonly string[];
  readonly escalations: readonly EscalationRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly resumedWithGuidance: boolean;
}

// ---------------------------------------------------------------------------
// Typed human-escalation suspension: form + resumeSchema + serialized state.
// The payload round-trips through the kernel's SuspensionRecord (journaled),
// so the suspension IS the loop's checkpoint — resume rebuilds from it.
// ---------------------------------------------------------------------------

export interface LoopState {
  iteration: number;
  rung: number;
  startAtIso: string;
  verifyFailStreak: number;
  recentHashes: string[];
  lastObservation: string;
  guidance: string | undefined;
  tokensCharged: number;
  attempts: AttemptRecord[];
  escalations: EscalationRecord[];
  rungPath: string[];
  modelBindingId: string;
  verifierBindingId: string;
}

export interface HumanEscalationPayload {
  readonly kind: 'dev.kyxo.loop/HumanEscalation';
  readonly form: {
    readonly question: string;
    readonly objective: string;
    readonly trigger: 'stagnation' | 'repeated-failure';
    readonly attempts: readonly AttemptRecord[];
  };
  readonly resumeSchema: { readonly guidance: 'string' };
  readonly loopState: LoopState;
}

export interface ResumeGuidance { readonly guidance?: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stagnation detector input: hash of the (observation, action) pair ONLY —
 *  never the iteration counter or the growing transcript, or nothing would
 *  ever look stagnant (doc-10 §3.2: hash declared progress, not raw text). */
export function progressHash(observation: string, action: LoopAction): string {
  return 'ph:' + createHash('sha256').update(JSON.stringify({ observation, action })).digest('hex').slice(0, 12);
}

/** Escalation as data: resolve a competence tier to a Binding by TRIAL
 *  NEGOTIATION over discovered manifests, registration order. Every loser
 *  leaves a `binding.rejected` journal record (the kernel writes it), so the
 *  ladder's history is reconstructible from the truth plane. */
function bindByTier(kernel: KernelApi, grantId: string, axis: string, tier: string): Binding {
  const candidates = kernel.listCapabilities().filter((m) => m.axes[axis] !== undefined);
  const problems: string[] = [];
  for (const m of candidates) {
    try {
      return kernel.bind({
        capabilityId: m.identity.id,
        grantId,
        requirements: [
          { axis, need: 'tier-at-least', tier },
          { axis: 'loopDialect', need: 'one-of', anyOf: ['kyxo-loop-json'] },
        ],
      });
    } catch (err) {
      problems.push(`${m.identity.id}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? ''}`);
    }
  }
  throw new Error(
    `bounded-loop: no capability satisfies ${axis} >= '${tier}' with loopDialect 'kyxo-loop-json' — considered: ${problems.join(' | ') || '(none declared the axis)'}`,
  );
}

const cloneState = (s: LoopState): LoopState => ({
  ...s,
  recentHashes: [...s.recentHashes],
  attempts: [...s.attempts],
  escalations: [...s.escalations],
  rungPath: [...s.rungPath],
});

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export const BOUNDED_LOOP_ID = 'bounded-loop';

export function makeBoundedLoop(): CapabilityProvider {
  const identity = { id: BOUNDED_LOOP_ID, version: '0.1.0', stability: 'experimental' } as const;
  return {
    identity,
    manifest: {
      identity,
      summary: 'Bounded observe->plan->act->verify loop; every control is declarative LoopPolicy config.',
      axes: {
        skeleton: { shape: 'options', offered: ['observe-plan-act-verify'] },
        bounded: { shape: 'flag', enabled: true },
        controls: {
          shape: 'options',
          offered: [
            'max-iterations', 'token-budget-grant', 'wall-clock', 'stagnation',
            'repeated-failure', 'escalation-ladder', 'human-escalation', 'cancellation',
          ],
        },
      },
      experimental: { checkpointInSuspensionPayload: true },
      extensions: { 'dev.kyxo.loop': { policyKind: LOOP_POLICY_KIND_NAME, modelDialect: 'kyxo-loop-json' } },
    },

    async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
      const kernel = ctx.kernel;
      const req = (request ?? {}) as Partial<LoopRequest>;
      const probs: string[] = [];
      if (typeof req.objective !== 'string' || req.objective === '') probs.push('objective: non-empty string required');
      probs.push(...policyProblems(req.policy));
      if (probs.length > 0) {
        yield { op: 'fail', error: `bounded-loop: invalid request — ${probs.join('; ')}` };
        return;
      }
      const objective = req.objective as string;
      const policy = req.policy as LoopPolicy;

      // ---- init, or restore from the typed human-escalation suspension ----
      let st: LoopState;
      if (ctx.resume !== undefined) {
        const payload = ctx.resume.suspension.payload as Partial<HumanEscalationPayload>;
        const input = (ctx.resume.input ?? {}) as ResumeGuidance;
        if (payload.kind !== 'dev.kyxo.loop/HumanEscalation' || payload.loopState === undefined) {
          yield { op: 'fail', error: 'bounded-loop: resumed without a HumanEscalation suspension payload' };
          return;
        }
        if (typeof input.guidance !== 'string' || input.guidance === '') {
          yield { op: 'fail', error: "bounded-loop: resume input must match resumeSchema { guidance: 'string' }" };
          return;
        }
        st = cloneState(payload.loopState);
        st.guidance = input.guidance;
        st.verifyFailStreak = 0;
        st.recentHashes = [];
        st.startAtIso = ctx.clock(); // human wait does not consume the deadline
        yield {
          op: 'progress',
          note: `resumed with human guidance after ${st.attempts.length} attempt(s) — failure streak and stagnation window reset`,
        };
      } else {
        const tier0 = policy.escalation.rungs[policy.escalation.startRung];
        if (tier0 === undefined) {
          yield { op: 'fail', error: `bounded-loop: startRung ${policy.escalation.startRung} is off the ladder` };
          return;
        }
        const model = bindByTier(kernel, ctx.grantId, policy.escalation.modelAxis, tier0);
        const verifier = kernel.bind({
          capabilityId: policy.verifierId,
          grantId: ctx.grantId,
          requirements: [{ axis: 'verdict', need: 'enabled' }],
        });
        st = {
          iteration: 0, rung: policy.escalation.startRung, startAtIso: ctx.clock(),
          verifyFailStreak: 0, recentHashes: [], lastObservation: '(none)', guidance: undefined,
          tokensCharged: 0, attempts: [], escalations: [], rungPath: [tier0],
          modelBindingId: model.id, verifierBindingId: verifier.id,
        };
        yield {
          op: 'progress',
          note: `bound model '${model.capabilityId}' at tier '${tier0}' (rung ${st.rung + 1}/${policy.escalation.rungs.length}); verifier '${verifier.capabilityId}'; policy ${req.policyArtifact ?? '(unpinned)'}`,
        };
      }

      const startMs = Date.parse(st.startAtIso);

      // ---- the loop -------------------------------------------------------
      while (st.iteration < policy.maxIterations) {
        st.iteration += 1;

        // CONTROL: wall-clock deadline, from the injected clock only.
        const elapsedMs = Date.parse(ctx.clock()) - startMs;
        if (policy.wallClockMs !== null && elapsedMs >= policy.wallClockMs) {
          yield { op: 'fail', error: `bounded-loop: wall-clock deadline exceeded (${elapsedMs}ms elapsed >= ${policy.wallClockMs}ms limit) entering iteration ${st.iteration}` };
          return;
        }

        // Every yield is a kernel commit point; an external cancel lands here.
        const tierNow = policy.escalation.rungs[st.rung] ?? '?';
        yield { op: 'progress', note: `iteration ${st.iteration}/${policy.maxIterations} — tier '${tierNow}', elapsed ${elapsedMs}ms` };

        // OBSERVE + PLAN: deterministic context compile.
        const prompt =
          `OBJECTIVE: ${objective}\nITERATION: ${st.iteration}\nLAST-OBSERVATION: ${st.lastObservation}` +
          (st.guidance !== undefined ? `\nHUMAN-GUIDANCE: ${st.guidance}` : '');

        // ACT: one model invocation through the kernel.
        const m = await kernel.invoke(st.modelBindingId, { prompt }, { causationId: ctx.invocationId });
        if (m.state !== 'completed') {
          yield { op: 'fail', error: `bounded-loop: model invocation ${m.invocationId} ended '${m.state}': ${m.error ?? '(no error)'}` };
          return;
        }
        const reply = (m.output ?? {}) as Partial<ModelReply>;
        const action: LoopAction = reply.action ?? { kind: 'ponder' };
        const usageTokens = reply.usage?.tokens ?? 0;

        // VERIFY: only a submission is verifiable.
        let verdict: VerifierVerdict | undefined;
        if (action.kind === 'submit') {
          const v = await kernel.invoke(
            st.verifierBindingId,
            { objective, candidate: action.value },
            { causationId: ctx.invocationId },
          );
          if (v.state !== 'completed') {
            yield { op: 'fail', error: `bounded-loop: verifier invocation ended '${v.state}': ${v.error ?? '(no error)'}` };
            return;
          }
          verdict = (v.output ?? { ok: false, note: 'verifier returned nothing' }) as VerifierVerdict;
          st.attempts.push({ iteration: st.iteration, value: action.value, ok: verdict.ok, note: verdict.note });
        }
        const observation = action.kind === 'submit'
          ? `submitted ${action.value} -> ${verdict?.ok === true ? 'VERIFIED' : `REJECTED (${verdict?.note ?? ''})`}`
          : `pondered: ${reply.thought ?? '(no thought)'}`;
        st.lastObservation = observation;

        // CONTROL: stagnation — hash of observation+action.
        const hash = progressHash(observation, action);
        st.recentHashes.push(hash);
        if (st.recentHashes.length > policy.stagnationWindow) st.recentHashes.shift();

        // Partial-progress artifact BEFORE the token charge: if the very next
        // commit point kills the budget, the journal's last word from this
        // loop is a usable progress record.
        yield {
          op: 'artifact',
          content: {
            // objective included: partial records from DIFFERENT runs would
            // otherwise be byte-identical and the CAS dedup would silently
            // swallow the later run's journal record (observed; see findings)
            label: 'loop-partial-progress', objective, iteration: st.iteration, tier: tierNow,
            observation, attempts: [...st.attempts], tokensChargedBefore: st.tokensCharged, progressHash: hash,
          },
        };

        // CONTROL: token budget via Grant — the KERNEL adjudicates this
        // charge at the commit point; on exhaustion it transitions the loop
        // invocation to budget-exceeded (kernel-origin typed suspension).
        yield { op: 'charge', cost: { tokens: usageTokens }, note: `iteration ${st.iteration} model usage` };
        st.tokensCharged += usageTokens;

        // Success: verified submission terminates the loop.
        if (action.kind === 'submit' && verdict?.ok === true) {
          const result: LoopResult = {
            answer: action.value, terminationReason: 'objective-verified', iterations: st.iteration,
            tokensCharged: st.tokensCharged, rungPath: [...st.rungPath], escalations: [...st.escalations],
            attempts: [...st.attempts], resumedWithGuidance: st.guidance !== undefined,
          };
          yield { op: 'progress', note: `iteration ${st.iteration}: verified answer ${action.value} — terminating` };
          yield { op: 'result', output: result };
          return;
        }
        if (verdict !== undefined && !verdict.ok) st.verifyFailStreak += 1;

        // CONTROL evaluation: stagnation and repeated-failure triggers.
        const stagnant =
          st.recentHashes.length >= policy.stagnationWindow &&
          st.recentHashes.every((h) => h === st.recentHashes[0]);
        const failing = st.verifyFailStreak >= policy.maxConsecutiveVerifyFailures;
        const trigger: 'stagnation' | 'repeated-failure' | undefined =
          stagnant && policy.escalation.onStagnation ? 'stagnation'
            : failing && policy.escalation.onRepeatedFailure ? 'repeated-failure'
              : undefined;
        if (trigger === undefined) continue;

        const fromTier = policy.escalation.rungs[st.rung] ?? '?';
        if (st.rung + 1 < policy.escalation.rungs.length) {
          // CONTROL: escalation ladder — re-bind the model requirement one
          // tier up. A fresh negotiation, a fresh Binding, all journaled.
          const toTier = policy.escalation.rungs[st.rung + 1] as string;
          yield { op: 'progress', note: `ESCALATION (${trigger}): re-binding model requirement '${policy.escalation.modelAxis}' tier '${fromTier}' -> '${toTier}'` };
          const next = bindByTier(kernel, ctx.grantId, policy.escalation.modelAxis, toTier);
          st.rung += 1;
          st.modelBindingId = next.id;
          st.rungPath.push(toTier);
          st.escalations.push({ iteration: st.iteration, trigger, fromTier, toTier });
          st.recentHashes = [];
          st.verifyFailStreak = 0;
          continue;
        }
        if (policy.escalation.humanFinalRung) {
          // CONTROL: human escalation as the final rung — typed suspension
          // whose payload carries form + resumeSchema + full loop state.
          const payload: HumanEscalationPayload = {
            kind: 'dev.kyxo.loop/HumanEscalation',
            form: {
              question: `The loop is stuck on '${objective}' (${trigger} at top rung '${fromTier}'). Provide guidance.`,
              objective, trigger, attempts: [...st.attempts],
            },
            resumeSchema: { guidance: 'string' },
            loopState: cloneState(st),
          };
          yield { op: 'progress', note: `ESCALATION (${trigger}): ladder exhausted at tier '${fromTier}' — suspending for human guidance (final rung)` };
          yield { op: 'suspend', reason: 'input-required', payload };
          return;
        }
        yield { op: 'fail', error: `bounded-loop: escalation ladder exhausted on '${trigger}' at tier '${fromTier}' and no human final rung configured` };
        return;
      }

      yield { op: 'fail', error: `bounded-loop: max-iterations (${policy.maxIterations}) reached without a verified result` };
    },
  };
}
