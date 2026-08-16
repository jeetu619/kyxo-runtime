/**
 * demo.ts — five runs of the bounded loop, one per termination path, on ONE
 * kernel instance (imported UNMODIFIED from prototypes/kernel/), one journal:
 *
 *   run 1  success within bounds (strong model, verified answer)
 *   run 2  stagnation -> model escalation (basic -> frontier) -> success
 *   run 3  token-budget exhaustion -> budget-exceeded suspension with a
 *          partial-progress artifact + kernel Checkpoint of the cell
 *   run 4  external cancellation mid-loop -> canceled at a commit point
 *   run 5  repeated verification failure -> human-escalation suspension
 *          (typed payload) -> resume with guidance -> success
 *
 * plus a wall-clock control check (deadline via the injected clock) so every
 * declared LoopPolicy control is exercised, not just declared.
 *
 * Mock models: 'weak-model' (competence tier 'basic') is scripted to loop
 * uselessly — it ponders the same thought forever, which is exactly what the
 * stagnation hash detects. 'strong-model' (tier 'frontier') solves compute
 * objectives — except '(riddle)' objectives, where it is confidently wrong
 * until human guidance arrives. Models REPORT usage; the loop charges it.
 *
 * The clock is a fake advancing 100ms per call, injected into the kernel, so
 * wall-clock behaviour is deterministic. Every run asserts its expected
 * terminal/suspended state; the demo exits non-zero on any failed assertion.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../kernel/kernel.ts';
import type {
  CapabilityEvent, CapabilityProvider, InvocationOutcome, InvokeCtx, KernelEvent,
} from '../kernel/types.ts';
import {
  BOUNDED_LOOP_ID, LOOP_POLICY_KIND_NAME, loopPolicyKind, makeBoundedLoop,
} from './bounded-loop.ts';
import type {
  HumanEscalationPayload, LoopAction, LoopPolicy, LoopResult,
} from './bounded-loop.ts';

// ---------------------------------------------------------------------------
// Deterministic injected clock: +100ms per call (kernel journal appends and
// the loop's deadline checks all tick it).
// ---------------------------------------------------------------------------

let fakeNow = Date.parse('2026-08-16T00:00:00.000Z');
const clock = (): string => {
  fakeNow += 100;
  return new Date(fakeNow).toISOString();
};

const journalPath = join(mkdtempSync(join(tmpdir(), 'kyxo-loop-')), 'journal.jsonl');
const kernel = new Kernel({ journalPath, clock });

// ---------------------------------------------------------------------------
// Mock models: weak (scripted to loop uselessly) and strong (scripted to
// succeed). One factory; behaviour differences are DATA (rules + manifest).
// ---------------------------------------------------------------------------

interface ModelRule {
  readonly when: (prompt: string) => boolean;
  readonly reply: (prompt: string) => { thought: string; action: LoopAction };
  readonly tokens: number;
}

function makeMockModel(
  id: string,
  tier: string,
  rules: readonly ModelRule[],
  onCall?: (prompt: string) => void,
): CapabilityProvider {
  const identity = { id, version: '1.0.0', stability: 'stable' } as const;
  return {
    identity,
    manifest: {
      identity,
      summary: `Scripted mock model at competence tier '${tier}'.`,
      axes: {
        competence: { shape: 'tiered', tier, ladder: ['basic', 'frontier'] },
        loopDialect: { shape: 'options', offered: ['kyxo-loop-json'] },
        streaming: { shape: 'flag', enabled: false },
      },
      experimental: {},
      extensions: { 'dev.kyxo.mock': { scripted: true, rules: rules.length } },
    },
    async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
      const prompt = ((request ?? {}) as { prompt?: string }).prompt ?? '';
      onCall?.(prompt);
      const rule = rules.find((r) => r.when(prompt));
      if (rule === undefined) {
        yield { op: 'fail', error: `${id}: no scripted rule matches the prompt` };
        return;
      }
      const rep = rule.reply(prompt);
      // Usage is REPORTED, not charged: the loop charges at its commit point.
      yield { op: 'result', output: { thought: rep.thought, action: rep.action, usage: { tokens: rule.tokens } } };
    },
  };
}

// External canceler for run 4: an "operator" watching the journal. When the
// weak model is invoked the second time for the (cancel-me) objective, the
// operator cancels the loop invocation MID-FLIGHT; the kernel honors it at
// the loop's next commit point.
let cancelMeCalls = 0;
const operatorHook = (prompt: string): void => {
  if (!prompt.includes('(cancel-me)')) return;
  cancelMeCalls += 1;
  if (cancelMeCalls === 2) {
    const submitted = kernel.journal().filter((e) =>
      e.kind === 'invocation.submitted' &&
      (e.payload['invocation'] as { capabilityId?: string }).capabilityId === BOUNDED_LOOP_ID);
    const target = submitted[submitted.length - 1];
    if (target?.invocationId !== undefined) {
      kernel.cancel(target.invocationId, 'operator: external cancel mid-loop');
      console.log(`    [external] operator canceled ${target.invocationId} while iteration 2 was mid-flight`);
    }
  }
};

const weakModel = makeMockModel('weak-model', 'basic', [
  { // loops uselessly: identical thought, identical (non-)action, forever
    when: () => true,
    tokens: 40,
    reply: () => ({ thought: 'Let me reconsider the problem from first principles.', action: { kind: 'ponder' } }),
  },
], operatorHook);

const num = (s: string | undefined): number => (s === undefined ? -1 : Number(s));

const strongModel = makeMockModel('strong-model', 'frontier', [
  { // human guidance outranks everything
    when: (p) => p.includes('HUMAN-GUIDANCE'),
    tokens: 60,
    reply: (p) => {
      const m = /answer is (\d+)/.exec(p);
      const v = num(m?.[1]);
      return { thought: `Following the human guidance: the answer is ${v}.`, action: { kind: 'submit', value: v } };
    },
  },
  { // riddle objectives: confidently, persistently wrong
    when: (p) => p.includes('(riddle)'),
    tokens: 55,
    reply: () => ({ thought: 'Six sevens... clearly 41.', action: { kind: 'submit', value: 41 } }),
  },
  { // first iteration: decompose before answering
    when: (p) => /ITERATION: 1\b/.test(p),
    tokens: 50,
    reply: () => ({ thought: 'Decomposing: I need the product of the two factors.', action: { kind: 'ponder' } }),
  },
  { // otherwise: solve compute objectives correctly
    when: () => true,
    tokens: 60,
    reply: (p) => {
      const m = /compute (\d+)\s*\*\s*(\d+)/.exec(p);
      const v = m === null ? -1 : num(m[1]) * num(m[2]);
      return { thought: `Computed the product directly: ${v}.`, action: { kind: 'submit', value: v } };
    },
  },
]);

// The verifier: a deterministic arithmetic checker (verification is userland
// judgment behind a capability; the loop only sees the verdict).
const answerChecker: CapabilityProvider = {
  identity: { id: 'answer-checker', version: '1.0.0', stability: 'stable' },
  manifest: {
    identity: { id: 'answer-checker', version: '1.0.0', stability: 'stable' },
    summary: 'Deterministic verifier for compute-a*b objectives.',
    axes: { verdict: { shape: 'flag', enabled: true } },
    experimental: {},
    extensions: {},
  },
  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as { objective?: string; candidate?: number };
    const m = /compute (\d+)\s*\*\s*(\d+)/.exec(req.objective ?? '');
    if (m === null) {
      yield { op: 'fail', error: 'answer-checker: objective is not a compute-a*b task' };
      return;
    }
    const ok = req.candidate === num(m[1]) * num(m[2]);
    yield {
      op: 'result',
      output: { ok, note: ok ? `candidate ${req.candidate} is correct` : `candidate ${req.candidate} failed the arithmetic check` },
    };
  },
};

// Registration order matters for trial negotiation: weak before strong, so a
// 'basic' rung binds the weak model and only a 'frontier' rung rejects it.
kernel.registerCapability(weakModel);
kernel.registerCapability(strongModel);
kernel.registerCapability(answerChecker);
kernel.registerCapability(makeBoundedLoop());
kernel.registerKind(loopPolicyKind);

// ---------------------------------------------------------------------------
// Assertions and shared plumbing
// ---------------------------------------------------------------------------

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`    assert ok: ${msg}`);
  else { failures += 1; console.error(`    ASSERT FAILED: ${msg}`); }
}

const basePolicy = {
  wallClockMs: 120_000,
  verifierId: 'answer-checker',
} as const;

interface RunRow {
  readonly run: string;
  readonly scenario: string;
  readonly iterations: number;
  readonly reason: string;
  readonly tokens: number;
  readonly state: string;
}
const rows: RunRow[] = [];

interface RunHandle {
  readonly outcome: InvocationOutcome;
  readonly grantId: string;
  readonly cellId: string;
  readonly slice: readonly KernelEvent[];
}

function slice(fromSeq: number): readonly KernelEvent[] {
  return kernel.journal().filter((e) => e.seq >= fromSeq);
}

function iterationsStarted(events: readonly KernelEvent[], invocationId: string): number {
  return events.filter((e) =>
    e.kind === 'invocation.progress' && e.invocationId === invocationId &&
    /^iteration \d+\//.test(String(e.payload['note'] ?? ''))).length;
}

function tokensCharged(grantId: string): number {
  const g = kernel.getGrant(grantId);
  return (g.initial.tokens ?? 0) - (g.budgets.tokens ?? 0);
}

function printLoopTrace(events: readonly KernelEvent[], invocationId: string): void {
  for (const e of events) {
    if (e.kind === 'invocation.progress' && e.invocationId === invocationId) {
      console.log(`    . ${String(e.payload['note'])}`);
    }
    if (e.kind === 'invocation.transition' && e.invocationId === invocationId) {
      console.log(`    > ${String(e.payload['from'])} -> ${String(e.payload['to'])}${e.payload['reason'] !== undefined ? ` (${String(e.payload['reason'])})` : ''}`);
    }
  }
}

async function runLoop(
  runNo: string,
  scenario: string,
  objective: string,
  policy: LoopPolicy,
  budgets: { tokens: number; invocations: number },
): Promise<RunHandle> {
  console.log(`\n== run ${runNo}: ${scenario} ==`);
  console.log(`   objective: ${objective}`);
  const seqStart = (kernel.journal().at(-1)?.seq ?? 0) + 1;
  const grant = kernel.createGrant({
    rights: ['invoke:*'],
    budgets: { tokens: budgets.tokens, moneyCents: null, invocations: budgets.invocations, spawnDepth: 3 },
    label: `loop-run-${runNo}`,
  });
  const cell = kernel.createCell(`loop:run${runNo}`);
  const policyArtifact = kernel.createKindObject(LOOP_POLICY_KIND_NAME, policy);
  const binding = kernel.bind({
    capabilityId: BOUNDED_LOOP_ID,
    grantId: grant.id,
    requirements: [
      { axis: 'skeleton', need: 'one-of', anyOf: ['observe-plan-act-verify'] },
      { axis: 'bounded', need: 'enabled' },
    ],
  });
  const outcome = await kernel.invoke(
    binding.id,
    { objective, policy, policyArtifact },
    { cellId: cell.id, actorId: `demo:run${runNo}` },
  );
  const events = slice(seqStart);
  printLoopTrace(events, outcome.invocationId);
  return { outcome, grantId: grant.id, cellId: cell.id, slice: events };
}

function record(runNo: string, scenario: string, h: RunHandle, extraSlice?: readonly KernelEvent[]): void {
  const events = extraSlice ?? h.slice;
  const st = h.outcome.state;
  let reason: string;
  if (st === 'completed') reason = (h.outcome.output as LoopResult).terminationReason;
  else if (st === 'budget-exceeded') reason = `budget-exceeded: ${String((h.outcome.suspension?.payload as { dimension?: string } | undefined)?.dimension)}`;
  else if (st === 'canceled') {
    const tr = events.find((e) => e.kind === 'invocation.transition' && e.invocationId === h.outcome.invocationId && e.payload['to'] === 'canceled');
    reason = String(tr?.payload['reason'] ?? 'canceled');
  } else if (st === 'input-required') reason = 'suspended: human escalation';
  else reason = h.outcome.error ?? '(no reason)';
  rows.push({
    run: runNo, scenario,
    iterations: iterationsStarted(events, h.outcome.invocationId),
    reason, tokens: tokensCharged(h.grantId), state: st,
  });
}

// ---------------------------------------------------------------------------
// The five runs
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`bounded-loop demo — journal: ${journalPath}`);

  // -- run 1: success within bounds ----------------------------------------
  const p1: LoopPolicy = {
    ...basePolicy, maxIterations: 8, stagnationWindow: 3, maxConsecutiveVerifyFailures: 3,
    escalation: { modelAxis: 'competence', rungs: ['frontier'], startRung: 0, onStagnation: true, onRepeatedFailure: true, humanFinalRung: false },
  };
  const r1 = await runLoop('1', 'success within bounds', 'compute 6*7', p1, { tokens: 2000, invocations: 40 });
  const out1 = r1.outcome.output as LoopResult;
  check(r1.outcome.state === 'completed', `run 1 state is 'completed' (got '${r1.outcome.state}')`);
  check(out1.answer === 42, `run 1 verified answer is 42 (got ${out1.answer})`);
  check(out1.iterations === 2 && iterationsStarted(r1.slice, r1.outcome.invocationId) === 2,
    'run 1 took 2 iterations (loop output and journal agree)');
  check(out1.escalations.length === 0, 'run 1 needed no escalation');
  record('1', 'success within bounds', r1);

  // -- run 2: stagnation -> model escalation -> success --------------------
  const p2: LoopPolicy = {
    ...basePolicy, maxIterations: 10, stagnationWindow: 3, maxConsecutiveVerifyFailures: 3,
    escalation: { modelAxis: 'competence', rungs: ['basic', 'frontier'], startRung: 0, onStagnation: true, onRepeatedFailure: true, humanFinalRung: false },
  };
  const r2 = await runLoop('2', 'stagnation -> model escalation -> success', 'compute 6*7 after the junior model has a go', p2, { tokens: 2000, invocations: 40 });
  const out2 = r2.outcome.output as LoopResult;
  check(r2.outcome.state === 'completed', `run 2 state is 'completed' (got '${r2.outcome.state}')`);
  check(out2.answer === 42, `run 2 verified answer is 42 (got ${out2.answer})`);
  check(out2.escalations.length === 1 && out2.escalations[0]?.trigger === 'stagnation'
    && out2.escalations[0]?.fromTier === 'basic' && out2.escalations[0]?.toTier === 'frontier',
    "run 2 escalated once, on stagnation, tier 'basic' -> 'frontier'");
  check(out2.rungPath.join('>') === 'basic>frontier', `run 2 rung path is basic>frontier (got ${out2.rungPath.join('>')})`);
  const rejected2 = r2.slice.filter((e) => e.kind === 'binding.rejected' && e.payload['capabilityId'] === 'weak-model');
  check(rejected2.length === 1, "run 2 journal holds weak-model's binding.rejected from the escalation re-negotiation");
  check(out2.iterations === 4, `run 2 took 4 iterations: 3 stagnant + 1 after escalation (got ${out2.iterations})`);
  record('2', 'stagnation -> escalation -> success', r2);

  // -- run 3: token-budget exhaustion -> budget-exceeded + checkpoint ------
  const p3: LoopPolicy = {
    ...basePolicy, maxIterations: 20, stagnationWindow: 3, maxConsecutiveVerifyFailures: 3,
    escalation: { modelAxis: 'competence', rungs: ['basic'], startRung: 0, onStagnation: false, onRepeatedFailure: false, humanFinalRung: false },
  };
  const r3 = await runLoop('3', 'token-budget exhaustion (grant tokens=100, 40/iteration)', 'compute 6*7 under a starvation budget', p3, { tokens: 100, invocations: 40 });
  check(r3.outcome.state === 'budget-exceeded', `run 3 state is 'budget-exceeded' (got '${r3.outcome.state}')`);
  const susp3 = r3.outcome.suspension;
  check(susp3?.origin === 'kernel' && (susp3.payload as { dimension?: string }).dimension === 'tokens',
    'run 3 suspension is kernel-origin with dimension=tokens');
  check(tokensCharged(r3.grantId) === 80, `run 3 charged exactly 80 tokens: two full iterations, the third denied (got ${tokensCharged(r3.grantId)})`);
  const partials3 = r3.slice.filter((e) => e.kind === 'artifact.stored'
    && ((e.payload['artifact'] as { content?: { label?: string } }).content?.label === 'loop-partial-progress'));
  const lastPartial3 = partials3[partials3.length - 1];
  const lastIter3 = lastPartial3 === undefined
    ? undefined
    : (lastPartial3.payload['artifact'] as { content?: { iteration?: number } }).content?.iteration;
  check(partials3.length === 3 && lastIter3 === 3,
    `run 3 left a partial-progress artifact for the iteration killed mid-charge (iteration ${String(lastIter3)})`);
  const cp3 = kernel.checkpoint(r3.cellId);
  check(cp3.pending.includes(r3.outcome.invocationId),
    `run 3 checkpoint ${cp3.id} lists the budget-exceeded invocation as pending (resumable under a re-grant)`);
  console.log(`    checkpoint ${cp3.id}: journalSeq=${cp3.journalSeq}, pending=[${cp3.pending.join(', ')}]`);
  record('3', 'token-budget exhaustion', r3);

  // -- run 4: external cancellation mid-loop -------------------------------
  const p4: LoopPolicy = {
    ...basePolicy, maxIterations: 50, stagnationWindow: 10, maxConsecutiveVerifyFailures: 10,
    escalation: { modelAxis: 'competence', rungs: ['basic'], startRung: 0, onStagnation: false, onRepeatedFailure: false, humanFinalRung: false },
  };
  const r4 = await runLoop('4', 'external cancellation mid-loop', 'compute 6*7 (cancel-me)', p4, { tokens: 5000, invocations: 60 });
  check(r4.outcome.state === 'canceled', `run 4 state is 'canceled' (got '${r4.outcome.state}')`);
  const cancelTr4 = r4.slice.find((e) => e.kind === 'invocation.transition'
    && e.invocationId === r4.outcome.invocationId && e.payload['to'] === 'canceled');
  check(cancelTr4 !== undefined && String(cancelTr4.payload['reason'] ?? '').includes('commit point'),
    'run 4 journal shows the cancel honored at a commit point, not preemptively');
  const afterCancel4 = r4.slice.filter((e) => e.kind === 'invocation.submitted' && e.seq > (cancelTr4?.seq ?? 0));
  check(afterCancel4.length === 0, 'run 4: zero invocations submitted after the cancellation — clean propagation');
  check(iterationsStarted(r4.slice, r4.outcome.invocationId) === 2, 'run 4 was canceled during iteration 2');
  check(tokensCharged(r4.grantId) === 40, `run 4 charged only iteration 1's tokens; the canceled iteration's charge never committed (got ${tokensCharged(r4.grantId)})`);
  record('4', 'external cancellation', r4);

  // -- run 5: repeated verify failure -> human escalation -> resume --------
  const p5: LoopPolicy = {
    ...basePolicy, maxIterations: 10, stagnationWindow: 4, maxConsecutiveVerifyFailures: 2,
    escalation: { modelAxis: 'competence', rungs: ['frontier'], startRung: 0, onStagnation: false, onRepeatedFailure: true, humanFinalRung: true },
  };
  const r5 = await runLoop('5', 'repeated verify failure -> human escalation -> resume', 'compute 6*7 (riddle)', p5, { tokens: 2000, invocations: 40 });
  check(r5.outcome.state === 'input-required', `run 5 first lands in 'input-required' (got '${r5.outcome.state}')`);
  const payload5 = r5.outcome.suspension?.payload as HumanEscalationPayload | undefined;
  check(payload5?.kind === 'dev.kyxo.loop/HumanEscalation' && payload5.resumeSchema.guidance === 'string',
    'run 5 suspension payload is typed: form + resumeSchema + serialized loop state');
  check(payload5?.form.trigger === 'repeated-failure' && payload5.form.attempts.length === 2
    && payload5.form.attempts.every((a) => a.value === 41 && !a.ok),
    'run 5 escalation form carries both failed attempts (41, rejected twice)');
  console.log(`    [human] form: ${payload5?.form.question}`);
  console.log(`    [human] resuming with guidance: 'Recall Deep Thought: the answer is 42.'`);
  const seq5b = (kernel.journal().at(-1)?.seq ?? 0) + 1;
  const resumed5 = await kernel.resume(r5.outcome.invocationId, { guidance: 'Recall Deep Thought: the answer is 42.' });
  const slice5b = slice(seq5b);
  printLoopTrace(slice5b, resumed5.invocationId);
  const out5 = resumed5.output as LoopResult;
  check(resumed5.state === 'completed', `run 5 completes after human guidance (got '${resumed5.state}')`);
  check(out5.answer === 42 && out5.resumedWithGuidance, `run 5 verified answer 42, flagged as human-guided`);
  check(out5.iterations === 3 && out5.attempts.length === 3, 'run 5: iteration 3 (restored from the suspension payload) succeeded');
  const full5 = { ...r5, outcome: resumed5, slice: slice(r5.slice[0]?.seq ?? 0) };
  record('5', 'verify failure -> human -> success', full5);

  // -- control check: wall-clock deadline (not one of the five paths) ------
  console.log('\n== control check: wall-clock deadline (injected clock) ==');
  const pW: LoopPolicy = {
    ...basePolicy, wallClockMs: 600, maxIterations: 50, stagnationWindow: 10, maxConsecutiveVerifyFailures: 10,
    escalation: { modelAxis: 'competence', rungs: ['basic'], startRung: 0, onStagnation: false, onRepeatedFailure: false, humanFinalRung: false },
  };
  const rW = await runLoop('W', 'wall-clock deadline (600ms budget, 100ms/tick clock)', 'compute 6*7 slowly', pW, { tokens: 5000, invocations: 60 });
  check(rW.outcome.state === 'failed' && (rW.outcome.error ?? '').includes('wall-clock deadline exceeded'),
    `wall-clock control terminates the loop (state '${rW.outcome.state}': ${rW.outcome.error ?? ''})`);

  // -- summary table --------------------------------------------------------
  const header = ['run', 'scenario', 'iter', 'termination reason', 'tokens', 'final state'];
  const cells = rows.map((r) => [r.run, r.scenario, String(r.iterations), r.reason, String(r.tokens), r.state]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? '').length)));
  const line = (c: readonly string[]): string => c.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ');
  console.log('\n== summary ==');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(line(c));

  const expected = ['completed', 'completed', 'budget-exceeded', 'canceled', 'completed'];
  const got = rows.map((r) => r.state);
  check(got.join(',') === expected.join(','),
    `all five runs landed in their expected states [${expected.join(', ')}]`);

  console.log(`\njournal: ${kernel.journal().length} events at ${journalPath}`);
  if (failures > 0) {
    console.error(`\nDEMO FAILED: ${failures} assertion(s) did not hold`);
    process.exitCode = 1;
  } else {
    console.log('\nALL RUNS LANDED IN THEIR EXPECTED TERMINAL/SUSPENDED STATES');
  }
}

await main();
