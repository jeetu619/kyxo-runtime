/**
 * behaviour.ts — the HarnessBehaviour contract (spine §5; doc-10 §1.3 shape)
 * and runHarness(), the tiny generic loop owner ("driver").
 *
 * Division of labour (doc-10 §1.2):
 *  - the DRIVER owns the mechanics every loop needs: per-turn journaling
 *    (TurnRecord Kind objects in the truth plane), budget accounting per
 *    model invocation (charges land at kernel commit points; the driver
 *    measures them by diffing grant snapshots around each invoke), a
 *    checkpoint at every yield point, max-turns derived from the grant's
 *    invocation budget, and failure-streak accounting (LoopSignals);
 *  - the BEHAVIOUR owns the judgment: context compilation, action choice,
 *    observation integration, continuation decision, optional verification.
 *
 * THE POINT: the kernel sees neither. It sees cells, bindings, invocations,
 * artifacts, checkpoints. runHarness records every kernel verb it uses so
 * demo.ts can prove that two very different behaviours present an IDENTICAL
 * call profile at the kernel boundary.
 *
 * Prototype simplifications vs doc-10 §1.3:
 *  - act() returns exactly ONE invocation intent per turn, and the behaviour
 *    has NO invoke verb at all (doc-10 offers ctx.invoke): intents-only is
 *    stricter and makes the kernel-boundary proof clean.
 *  - ContinuationDecision is cut to continue/finalize/fail (delegate,
 *    suspend, switch-strategy, escalate, rollback are unexercised here).
 *  - Callbacks may be sync or async (MaybePromise).
 *  - No ctx.clock: the kernel's injected clock is not publicly exposed, so
 *    harness records carry no timestamps (see findings).
 */

import type { Kernel } from '../kernel/kernel.ts';
import type {
  ArtifactMeta, AxisRequirement, Binding, Budget, Budgets, InvocationState, KindDefinition,
} from '../kernel/types.ts';

export type MaybePromise<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// The behaviour contract
// ---------------------------------------------------------------------------

/** A capability the behaviour needs bound (negotiated) before the loop runs. */
export interface BindingNeed {
  readonly alias: string;
  readonly capabilityId: string;
  /** 'model' turns are the budget-metered ones the driver accounts per-invocation. */
  readonly role: 'model' | 'tool';
  readonly requirements: readonly AxisRequirement[];
}

/** Deterministically compiled per-invocation view (context ≠ memory, spine §5). */
export interface CompiledContext {
  readonly prompt: string;
  /** Provenance labels of what was compiled in. */
  readonly sources: readonly string[];
  readonly tokenEstimate: number;
}

/** One observation folded back into behaviour state. */
export type Observation =
  | { readonly kind: 'model-reply'; readonly invocationId: string; readonly output: unknown }
  | { readonly kind: 'tool-result'; readonly invocationId: string; readonly output: unknown }
  | { readonly kind: 'invocation-trouble'; readonly invocationId: string; readonly state: InvocationState; readonly error: string };

/** act() returns an intent, not an effect: the driver executes and journals it. */
export interface ActIntent {
  /** Alias into the behaviour's declared BindingNeeds. */
  readonly binding: string;
  readonly request: unknown;
  /** Human-readable note, journaled in the TurnRecord. */
  readonly note: string;
}

/** Driver accounting handed to decideContinuation (doc-10 LoopSignals subset). */
export interface LoopSignals {
  readonly turn: number;
  readonly maxTurns: number;
  readonly failureStreak: number;
  readonly budgetRemaining: Budgets;
}

/** Closed decision union — the driver stays total over it. */
export type ContinuationDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'finalize'; readonly output: unknown }
  | { readonly kind: 'fail'; readonly error: string };

/** Everything a behaviour callback may touch. No invoke verb, no ambient
 *  authority: effects flow through act() intents executed by the driver. */
export interface HarnessCtx {
  readonly cellId: string;
  readonly objective: string;
  readonly objectiveArtifact: string;
  /** Sealed negotiation results, by alias. */
  readonly bindings: Readonly<Record<string, Binding>>;
  /** Read-only snapshot of the run grant's remaining budgets. */
  readonly grantRemaining: () => Budgets;
  readonly storeArtifact: (content: unknown, meta?: ArtifactMeta) => string;
  readonly createKindObject: (kindName: string, payload: unknown) => string;
}

/** A harness is a behaviour module implementing this contract. */
export interface HarnessBehaviour<S> {
  readonly id: string;
  readonly version: string;
  readonly summary: string;
  readonly needs: readonly BindingNeed[];
  /** Establish initial behaviour state from the objective. Pure of effects. */
  init(ctx: HarnessCtx): MaybePromise<S>;
  compileContext(ctx: HarnessCtx, state: S): MaybePromise<CompiledContext>;
  act(ctx: HarnessCtx, state: S, view: CompiledContext): MaybePromise<ActIntent>;
  integrateObservation(ctx: HarnessCtx, state: S, obs: Observation): MaybePromise<S>;
  decideContinuation(ctx: HarnessCtx, state: S, signals: LoopSignals): MaybePromise<ContinuationDecision>;
  /** Optional: produce Evidence artifact hashes for a candidate outcome. */
  verify?(ctx: HarnessCtx, state: S, candidateArtifact: string): MaybePromise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// Kinds the driver journals with (registered by the demo, CRD-style)
// ---------------------------------------------------------------------------

export const OBJECTIVE_KIND_NAME = 'dev.kyxo.harness/Objective';
export const TURN_RECORD_KIND_NAME = 'dev.kyxo.harness/TurnRecord';

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

export const objectiveKind: KindDefinition = {
  name: OBJECTIVE_KIND_NAME, version: 'v1',
  validate: (p) => {
    const o = p as { objective?: unknown; harness?: unknown } | null;
    if (o === null || typeof o !== 'object') return ['payload must be an object'];
    const errs: string[] = [];
    if (!str(o.objective)) errs.push('objective: non-empty string required');
    if (!str(o.harness)) errs.push('harness: non-empty string required');
    return errs;
  },
};

export const turnRecordKind: KindDefinition = {
  name: TURN_RECORD_KIND_NAME, version: 'v1',
  validate: (p) => {
    const o = p as Record<string, unknown> | null;
    if (o === null || typeof o !== 'object') return ['payload must be an object'];
    const errs: string[] = [];
    if (!str(o['harness'])) errs.push('harness: non-empty string required');
    if (typeof o['turn'] !== 'number' || !Number.isInteger(o['turn']) || (o['turn'] as number) < 1) errs.push('turn: positive integer required');
    if (!str(o['binding'])) errs.push('binding: non-empty string required');
    if (o['role'] !== 'model' && o['role'] !== 'tool') errs.push("role: 'model' | 'tool' required");
    if (!str(o['invocationId'])) errs.push('invocationId: non-empty string required');
    if (!str(o['state'])) errs.push('state: non-empty string required');
    if (!str(o['decision'])) errs.push('decision: non-empty string required');
    if (typeof o['tokensCharged'] !== 'number' || (o['tokensCharged'] as number) < 0) errs.push('tokensCharged: number >= 0 required');
    return errs;
  },
};

// ---------------------------------------------------------------------------
// runHarness — the generic loop owner
// ---------------------------------------------------------------------------

export interface TurnTrace {
  readonly turn: number;
  readonly binding: string;
  readonly role: 'model' | 'tool';
  readonly note: string;
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly tokensCharged: number;
  readonly decision: ContinuationDecision['kind'];
  readonly turnRecordArtifact: string;
  readonly checkpointId: string;
}

export interface HarnessRunResult {
  readonly harness: string;
  readonly objective: string;
  readonly cellId: string;
  readonly grantId: string;
  readonly status: 'completed' | 'failed';
  readonly output: unknown;
  readonly outputArtifact: string | undefined;
  readonly evidence: readonly string[];
  readonly error: string | undefined;
  readonly turns: readonly TurnTrace[];
  readonly maxTurns: number;
  readonly modelInvocations: number;
  readonly toolInvocations: number;
  readonly tokensCharged: number;
  readonly centsCharged: number;
  /** Every kernel verb the driver (and behaviour, via ctx) used, in order. */
  readonly kernelCalls: readonly string[];
  /** Journal seq range [first, last] covered by this run. */
  readonly journalSeqRange: readonly [number, number];
}

const FALLBACK_MAX_TURNS = 16;

const spent = (before: Budget, after: Budget): number =>
  before === null || after === null ? 0 : before - after;

export async function runHarness<S>(
  kernel: Kernel,
  behaviour: HarnessBehaviour<S>,
  objective: string,
  grantId: string,
): Promise<HarnessRunResult> {
  const kernelCalls: string[] = [];
  const rec = (verb: string): void => { kernelCalls.push(verb); };
  const harnessTag = `${behaviour.id}@${behaviour.version}`;

  rec('journal');
  const seqStart = (kernel.journal().at(-1)?.seq ?? 0) + 1;

  rec('createCell');
  const cell = kernel.createCell(`harness:${behaviour.id}`);

  rec('createKindObject');
  const objectiveArtifact = kernel.createKindObject(OBJECTIVE_KIND_NAME, { objective, harness: harnessTag });

  const bindings: Record<string, Binding> = {};
  const roleOf = new Map<string, 'model' | 'tool'>();
  for (const need of behaviour.needs) {
    rec('bind');
    bindings[need.alias] = kernel.bind({ capabilityId: need.capabilityId, grantId, requirements: need.requirements });
    roleOf.set(need.alias, need.role);
  }

  const remaining = (): Budgets => {
    rec('getGrant');
    return { ...kernel.getGrant(grantId).budgets };
  };

  /** Max-turns honored FROM THE GRANT: the invocation budget bounds turns,
   *  because this driver admits exactly one invocation per turn. */
  const maxTurns = remaining().invocations ?? FALLBACK_MAX_TURNS;

  const ctx: HarnessCtx = {
    cellId: cell.id,
    objective,
    objectiveArtifact,
    bindings,
    grantRemaining: remaining,
    storeArtifact: (content, meta) => { rec('storeArtifact'); return kernel.storeArtifact(content, meta); },
    createKindObject: (kindName, payload) => { rec('createKindObject'); return kernel.createKindObject(kindName, payload); },
  };

  const turns: TurnTrace[] = [];
  let failureStreak = 0;
  let status: 'completed' | 'failed' = 'failed';
  let output: unknown;
  let outputArtifact: string | undefined;
  let evidence: readonly string[] = [];
  let error: string | undefined;
  let modelInvocations = 0;
  let toolInvocations = 0;
  let tokensCharged = 0;
  let centsCharged = 0;

  try {
    let state = await behaviour.init(ctx);
    for (let turn = 1; ; turn += 1) {
      if (turn > maxTurns) {
        error = `max-turns exhausted (${maxTurns}, derived from the grant's invocation budget) without a terminal decision`;
        break;
      }

      // observe/orient: deterministic context compile, then one action intent
      const view = await behaviour.compileContext(ctx, state);
      const intent = await behaviour.act(ctx, state, view);
      const binding = bindings[intent.binding];
      const role = roleOf.get(intent.binding);
      if (binding === undefined || role === undefined) {
        throw new Error(`behaviour '${behaviour.id}' acted on undeclared binding alias '${intent.binding}'`);
      }

      // act: the ONLY effect verb — one kernel invocation, budget measured around it
      const before = remaining();
      rec('invoke');
      const inv = await kernel.invoke(binding.id, intent.request, { cellId: cell.id, actorId: `harness:${behaviour.id}` });
      const after = remaining();
      const tok = spent(before.tokens, after.tokens);
      tokensCharged += tok;
      centsCharged += spent(before.moneyCents, after.moneyCents);
      if (role === 'model') modelInvocations += 1; else toolInvocations += 1;

      // integrate: fold the observation into behaviour state
      const obs: Observation = inv.state === 'completed'
        ? { kind: role === 'model' ? 'model-reply' : 'tool-result', invocationId: inv.invocationId, output: inv.output }
        : { kind: 'invocation-trouble', invocationId: inv.invocationId, state: inv.state, error: inv.error ?? `(ended '${inv.state}' with no error message)` };
      failureStreak = inv.state === 'completed' ? 0 : failureStreak + 1;
      state = await behaviour.integrateObservation(ctx, state, obs);

      // judge: continuation decision under driver-computed signals
      const decision = await behaviour.decideContinuation(ctx, state, {
        turn, maxTurns, failureStreak, budgetRemaining: after,
      });

      // yield point: journal the turn in the truth plane, then checkpoint
      rec('createKindObject');
      const turnRecordArtifact = kernel.createKindObject(TURN_RECORD_KIND_NAME, {
        harness: harnessTag, turn, binding: intent.binding, role, note: intent.note,
        invocationId: inv.invocationId, state: inv.state, tokensCharged: tok, decision: decision.kind,
      });
      rec('checkpoint');
      const cp = kernel.checkpoint(cell.id);
      turns.push({
        turn, binding: intent.binding, role, note: intent.note, invocationId: inv.invocationId,
        state: inv.state, tokensCharged: tok, decision: decision.kind, turnRecordArtifact, checkpointId: cp.id,
      });

      if (decision.kind === 'continue') continue;
      if (decision.kind === 'finalize') {
        output = decision.output;
        outputArtifact = ctx.storeArtifact(
          { harness: harnessTag, objective, output: decision.output },
          { inputs: [objectiveArtifact] },
        );
        if (behaviour.verify !== undefined) {
          evidence = await behaviour.verify(ctx, state, outputArtifact);
        }
        status = 'completed';
      } else {
        error = decision.error;
      }
      break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  rec('journal');
  const seqEnd = kernel.journal().at(-1)?.seq ?? 0;

  return {
    harness: harnessTag, objective, cellId: cell.id, grantId, status, output, outputArtifact,
    evidence, error, turns, maxTurns, modelInvocations, toolInvocations, tokensCharged,
    centsCharged, kernelCalls, journalSeqRange: [seqStart, seqEnd],
  };
}
