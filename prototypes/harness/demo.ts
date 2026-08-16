/**
 * demo.ts — harness A/B: two orchestration strategies, one kernel boundary.
 *
 * The SAME objective ("compute (3+4)*10 and report") and the SAME mock model
 * capability (one provider, one capability id, two named scripted sessions —
 * per-harness scripts are DATA on the model side, negotiated via an options
 * axis) run through BOTH harness behaviours:
 *
 *   ReactiveHarness  — act immediately; model->tool loop; terminate on
 *                      no-tool-call (3 model calls, 2 tool calls)
 *   PlanningHarness  — first turn produces a Plan (a registered Kind);
 *                      executes steps; replans ONCE on a failed step;
 *                      terminates when the plan is complete
 *                      (2 model calls, 3 tool calls, 2 Plan versions)
 *
 * The kernel (imported UNMODIFIED from prototypes/kernel/) never learns the
 * reasoning strategy: the demo prints both event traces side-by-side and
 * diffs the kernel API verbs and journal event kinds each run produced —
 * they are IDENTICAL in kind. Strategy divergence lives entirely in
 * behaviour state and manifest data the kernel treats as opaque.
 *
 * NOTE: the kernel prototype's own mock-llm has its script table baked to
 * the universality demo's objectives; per-harness sessions cannot be
 * expressed without editing kernel files, so this demo ships a
 * session-scripted model implementing the same CapabilityProvider contract.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../kernel/kernel.ts';
import type { Binding, CapabilityEvent, CapabilityProvider, InvokeCtx, KernelEvent } from '../kernel/types.ts';
import { calculatorTool } from '../kernel/capabilities/calculator-tool.ts';

import { objectiveKind, turnRecordKind, runHarness } from './behaviour.ts';
import type { HarnessRunResult } from './behaviour.ts';
import { makeReactiveHarness } from './reactive.ts';
import { makePlanningHarness, planKind, PLAN_KIND_NAME } from './planning.ts';

// ---------------------------------------------------------------------------
// The mock model: ONE capability, distinct scripted sessions
// ---------------------------------------------------------------------------

interface ScriptStep { readonly op: string; readonly a: number; readonly b: number; readonly note?: string }
interface ScriptReply {
  readonly text?: string;
  readonly toolCall?: ScriptStep;
  readonly plan?: { readonly title: string; readonly steps: readonly ScriptStep[] };
}
interface ScriptRule { readonly when: (prompt: string) => boolean; readonly reply: ScriptReply }

const tokensFor = (s: string): number => Math.ceil(s.length / 4);

function makeScriptedModel(id: string, sessions: Readonly<Record<string, readonly ScriptRule[]>>): CapabilityProvider {
  const identity = { id, version: '1.0.0', stability: 'stable' } as const;
  return {
    identity,
    manifest: {
      identity,
      summary: 'Deterministic mock model: one capability, distinct named scripted sessions (per-harness scripts as data).',
      axes: {
        toolDialect: { shape: 'options', offered: ['kyxo-json'] },
        streaming: { shape: 'flag', enabled: true },
        structuredOutput: { shape: 'tiered', tier: 'json', ladder: ['none', 'json', 'json-schema'] },
        session: { shape: 'options', offered: Object.keys(sessions) },
      },
      experimental: {},
      extensions: { 'dev.kyxo.mock': { sessions: Object.keys(sessions) } },
    },
    async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
      const req = (request ?? {}) as { session?: string; prompt?: string };
      const rules = sessions[req.session ?? ''];
      if (rules === undefined) {
        yield { op: 'fail', error: `scripted model: unknown session '${String(req.session)}'` };
        return;
      }
      const prompt = req.prompt ?? '';
      const rule = rules.find((r) => r.when(prompt));
      if (rule === undefined) {
        yield { op: 'fail', error: `scripted model: session '${String(req.session)}' has no rule for prompt "${prompt.slice(0, 60)}..."` };
        return;
      }
      const rendered = JSON.stringify(rule.reply);
      yield { op: 'progress', note: 'stream-chunk', data: rendered.slice(0, Math.ceil(rendered.length / 2)) };
      yield { op: 'progress', note: 'stream-chunk', data: rendered.slice(Math.ceil(rendered.length / 2)) };
      yield { op: 'charge', cost: { tokens: tokensFor(prompt) + tokensFor(rendered) + 16, moneyCents: 1 }, note: 'prompt+completion tokens' };
      yield { op: 'result', output: { ...rule.reply, usage: { promptTokens: tokensFor(prompt), completionTokens: tokensFor(rendered) + 16 } } };
    },
  };
}

const MODEL_ID = 'mock-model';
const OBJECTIVE = 'compute (3+4)*10 and report';

const SESSIONS: Readonly<Record<string, readonly ScriptRule[]>> = {
  // Reactive session: chained tool calls; the final reply has NO tool call.
  reactive: [
    { when: (p) => p.includes('TOOL-RESULT mul(7,10) = 70'), reply: { text: 'Objective complete: (3+4)*10 = 70.' } },
    { when: (p) => p.includes('TOOL-RESULT add(3,4) = 7'), reply: { toolCall: { op: 'mul', a: 7, b: 10 } } },
    { when: (p) => p.includes('OBJECTIVE: compute (3+4)*10'), reply: { toolCall: { op: 'add', a: 3, b: 4 } } },
  ],
  // Planning session: a Plan with a deliberately broken step 2 (op 'times'
  // does not exist on the calculator), then a corrected remainder on replan.
  planning: [
    {
      when: (p) => p.includes('REPLAN-REQUEST'),
      reply: { plan: { title: 'corrected remainder', steps: [{ op: 'mul', a: 7, b: 10, note: 'multiply running sum by 10' }] } },
    },
    {
      when: (p) => p.includes('PLAN-REQUEST'),
      reply: {
        plan: {
          title: 'compute (3+4)*10', steps: [
            { op: 'add', a: 3, b: 4, note: 'sum 3 and 4' },
            { op: 'times', a: 7, b: 10, note: 'scripted flaw: calculator has no op "times"' },
          ],
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Setup: one kernel, one model capability, the REUSED calculator tool
// ---------------------------------------------------------------------------

const scratch = process.env['KYXO_HARNESS_DIR'] ?? mkdtempSync(join(tmpdir(), 'kyxo-harness-'));
const journalPath = join(scratch, 'journal.jsonl');
let tick = 0;
const clock = (): string => new Date(Date.UTC(2026, 7, 16, 9, 0, 0) + tick++ * 1000).toISOString();

const kernel = new Kernel({ journalPath, clock });
kernel.registerCapability(makeScriptedModel(MODEL_ID, SESSIONS));
kernel.registerCapability(calculatorTool); // reused from prototypes/kernel/capabilities/
kernel.registerKind(objectiveKind);
kernel.registerKind(turnRecordKind);
kernel.registerKind(planKind);

const ROOT_TOKENS = 10_000;
const root = kernel.createGrant({
  rights: ['invoke:*'],
  budgets: { tokens: ROOT_TOKENS, moneyCents: 500, invocations: 100, spawnDepth: 4 },
  label: 'root',
});
const runGrant = (label: string) => kernel.attenuate(root.id, {
  rights: [`invoke:${MODEL_ID}`, `invoke:${calculatorTool.identity.id}`],
  budgets: { tokens: 4_000, moneyCents: 50, invocations: 12, spawnDepth: 1 },
  label,
});

const W = 65;
const section = (t: string): void => {
  console.log('\n' + '='.repeat(2 * W + 3) + '\n== ' + t + '\n' + '='.repeat(2 * W + 3));
};

section('HARNESS A/B — same objective, same model capability, same kernel');
console.log(` journal:   ${journalPath}`);
console.log(` objective: "${OBJECTIVE}" (both harnesses)`);
console.log(` model:     '${MODEL_ID}' — one capability, scripted sessions [${Object.keys(SESSIONS).join(', ')}] negotiated via the 'session' axis`);
console.log(` tool:      '${calculatorTool.identity.id}' — imported unmodified from prototypes/kernel/capabilities/calculator-tool.ts`);

const gReactive = runGrant('reactive-run');
const gPlanning = runGrant('planning-run');

const reactiveRun = await runHarness(
  kernel,
  makeReactiveHarness({ model: MODEL_ID, session: 'reactive', tool: calculatorTool.identity.id }),
  OBJECTIVE,
  gReactive.id,
);
const planningRun = await runHarness(
  kernel,
  makePlanningHarness({ model: MODEL_ID, session: 'planning', tool: calculatorTool.identity.id }),
  OBJECTIVE,
  gPlanning.id,
);

// ---------------------------------------------------------------------------
// Reporting helpers (journal filtering lives in the demo, not the kernel)
// ---------------------------------------------------------------------------

const uniq = (xs: readonly string[]): readonly string[] => [...new Set(xs)];
const sliceOf = (r: HarnessRunResult): readonly KernelEvent[] =>
  kernel.journal().filter((e) => e.seq >= r.journalSeqRange[0] && e.seq <= r.journalSeqRange[1]);
const plansIn = (r: HarnessRunResult): number =>
  sliceOf(r).filter((e) => e.kind === 'kind.object' && e.payload['kindName'] === PLAN_KIND_NAME).length;
const artifactsIn = (r: HarnessRunResult): number =>
  sliceOf(r).filter((e) => e.kind === 'artifact.stored').length;
const checkpointsIn = (r: HarnessRunResult): number =>
  sliceOf(r).filter((e) => e.kind === 'checkpoint.created').length;
const bindingsIn = (r: HarnessRunResult): readonly Binding[] =>
  sliceOf(r).filter((e) => e.kind === 'binding.created').map((e) => e.payload['binding'] as Binding);
const answerOf = (r: HarnessRunResult): string =>
  String((r.output as { answer?: unknown } | undefined)?.answer ?? '(none)');

function traceLines(r: HarnessRunResult): string[] {
  const L: string[] = [];
  L.push(`${r.harness}   [cell ${r.cellId}, grant ${r.grantId}]`);
  for (const b of bindingsIn(r)) L.push(` bind ${b.capabilityId}: ${JSON.stringify(b.negotiated)}`);
  L.push('-'.repeat(W - 2));
  for (const t of r.turns) {
    L.push(`T${t.turn} ${(t.role === 'model' ? 'MODEL' : 'TOOL').padEnd(5)} ${t.invocationId.padEnd(6)} ${t.state}${t.tokensCharged > 0 ? ` tok:${t.tokensCharged}` : ''} -> ${t.decision}`);
    L.push(`     ${t.note}`);
  }
  L.push('-'.repeat(W - 2));
  L.push(`status=${r.status}   turns=${r.turns.length}/${r.maxTurns} (max-turns from grant budget)`);
  L.push(`invocations: model=${r.modelInvocations} tool=${r.toolInvocations}`);
  L.push(`charged: tokens=${r.tokensCharged} cents=${r.centsCharged}`);
  L.push(`artifacts in journal slice: ${artifactsIn(r)}`);
  L.push(`  (Plan kind objects: ${plansIn(r)}, evidence artifacts: ${r.evidence.length})`);
  L.push(`checkpoints: ${checkpointsIn(r)} (one per yield point)`);
  L.push(`answer: ${answerOf(r)}`);
  return L;
}

const clip = (s: string): string => (s.length > W ? s.slice(0, W - 1) + '…' : s).padEnd(W);
function sideBySide(a: readonly string[], b: readonly string[]): void {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) console.log(`${clip(a[i] ?? '')} | ${clip(b[i] ?? '')}`);
}

section('EVENT TRACES SIDE-BY-SIDE — ReactiveHarness | PlanningHarness');
sideBySide(traceLines(reactiveRun), traceLines(planningRun));

// ---------------------------------------------------------------------------
// The kernel-boundary diff: what did the kernel actually see?
// ---------------------------------------------------------------------------

section('KERNEL-BOUNDARY DIFF — the kernel cannot tell the harnesses apart');

const apiA = uniq(reactiveRun.kernelCalls);
const apiB = uniq(planningRun.kernelCalls);
const apiSame = [...apiA].sort().join(',') === [...apiB].sort().join(',');
console.log(` kernel API verbs used (reactive): [${apiA.join(', ')}]`);
console.log(` kernel API verbs used (planning): [${apiB.join(', ')}]`);
console.log(apiSame
  ? ` DIFF: IDENTICAL in kind — ${apiA.length} verbs, zero strategy-specific kernel surface`
  : ` DIFF: MISMATCH — only-reactive=[${apiA.filter((v) => !apiB.includes(v)).join(',')}] only-planning=[${apiB.filter((v) => !apiA.includes(v)).join(',')}]`);

const jkA = [...uniq(sliceOf(reactiveRun).map((e) => e.kind))].sort();
const jkB = [...uniq(sliceOf(planningRun).map((e) => e.kind))].sort();
const journalSame = jkA.join(',') === jkB.join(',');
console.log(` journal event kinds (reactive): [${jkA.join(', ')}]`);
console.log(` journal event kinds (planning): [${jkB.join(', ')}]`);
console.log(journalSame
  ? ` DIFF: IDENTICAL in kind — ${jkA.length} journal record kinds; the strategies differ only in counts and payloads`
  : ` DIFF: MISMATCH — only-reactive=[${jkA.filter((k) => !jkB.includes(k)).join(',')}] only-planning=[${jkB.filter((k) => !jkA.includes(k)).join(',')}]`);

// ---------------------------------------------------------------------------
// Final assertions
// ---------------------------------------------------------------------------

section('FINAL ASSERTIONS');

const rootTokensSpent = ROOT_TOKENS - (kernel.getGrant(root.id).budgets.tokens ?? 0);
const grantReconciles = (grantId: string, r: HarnessRunResult): boolean => {
  const g = kernel.getGrant(grantId);
  return (g.initial.tokens ?? 0) - (g.budgets.tokens ?? 0) === r.tokensCharged
    && (g.initial.invocations ?? 0) - (g.budgets.invocations ?? 0) === r.turns.length;
};
const verdictOf = (hash: string | undefined): string =>
  hash === undefined ? '(no evidence)' : String((kernel.getArtifact(hash).content as { verdict?: unknown }).verdict);
const bothRuns = [reactiveRun, planningRun] as const;

const checks: Array<{ name: string; pass: boolean; detail: string }> = [
  {
    name: 'both-completed',
    pass: reactiveRun.status === 'completed' && planningRun.status === 'completed',
    detail: `reactive=${reactiveRun.status}, planning=${planningRun.status}`,
  },
  {
    name: 'same-answer-70',
    pass: answerOf(reactiveRun).includes('70') && (planningRun.output as { value?: number }).value === 70,
    detail: `reactive: "${answerOf(reactiveRun)}" / planning value: ${String((planningRun.output as { value?: number }).value)}`,
  },
  {
    name: 'strategies-differ',
    pass: reactiveRun.modelInvocations === 3 && reactiveRun.toolInvocations === 2
      && planningRun.modelInvocations === 2 && planningRun.toolInvocations === 3
      && plansIn(reactiveRun) === 0 && plansIn(planningRun) === 2,
    detail: 'reactive 3 model/2 tool, 0 plans; planning 2 model/3 tool, 2 Plan versions (replanned once)',
  },
  {
    name: 'termination-policies-differ',
    pass: reactiveRun.turns.at(-1)?.role === 'model' && reactiveRun.turns.at(-1)?.decision === 'finalize'
      && planningRun.turns.at(-1)?.role === 'tool' && planningRun.turns.at(-1)?.decision === 'finalize',
    detail: 'reactive ends on a no-tool-call model turn; planning ends when the plan completes after a tool turn',
  },
  {
    name: 'failed-step-replanned',
    pass: planningRun.turns.some((t) => t.state === 'failed') && planningRun.status === 'completed'
      && !reactiveRun.turns.some((t) => t.state !== 'completed'),
    detail: 'planning absorbed a failed invocation (bad op "times") via one replan; reactive saw no failures',
  },
  {
    name: 'kernel-boundary-identical',
    pass: apiSame && journalSame,
    detail: 'kernel API verb kinds AND journal event kinds are set-identical across both harnesses',
  },
  {
    name: 'budget-per-model-invocation',
    pass: bothRuns.every((r) => r.turns.every((t) => (t.role === 'model') === (t.tokensCharged > 0)))
      && grantReconciles(gReactive.id, reactiveRun) && grantReconciles(gPlanning.id, planningRun)
      && rootTokensSpent === reactiveRun.tokensCharged + planningRun.tokensCharged,
    detail: `every model turn charged tokens, no tool turn did; grants + root lineage reconcile (root spent ${rootTokensSpent} tokens)`,
  },
  {
    name: 'checkpoint-per-yield',
    pass: checkpointsIn(reactiveRun) === reactiveRun.turns.length
      && checkpointsIn(planningRun) === planningRun.turns.length,
    detail: `reactive ${checkpointsIn(reactiveRun)}/${reactiveRun.turns.length} turns, planning ${checkpointsIn(planningRun)}/${planningRun.turns.length} turns`,
  },
  {
    name: 'verify-optional',
    pass: reactiveRun.evidence.length === 0 && planningRun.evidence.length === 1
      && verdictOf(planningRun.evidence.at(0)) === 'pass',
    detail: `planning emitted Evidence (verdict=${verdictOf(planningRun.evidence.at(0))}) with provenance into candidate+plans; reactive skipped the optional callback`,
  },
];

let allPass = true;
for (const c of checks) {
  console.log(` ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(28)} ${c.detail}`);
  if (!c.pass) allPass = false;
}
console.log(`\n${allPass ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED'} — two reasoning strategies, one kernel boundary. Journal at ${journalPath} (${kernel.journal().length} records)`);
process.exitCode = allPass ? 0 : 1;
