/**
 * demo-universality.ts — proof-of-shape for the Kyxo kernel prototype.
 *
 * Eight wildly different capabilities (raw model, pure tool, MCP server,
 * harness agent, graph strategy, remote A2A agent, human approver, OpenAI-
 * compat local model) all run through the IDENTICAL kernel.invoke() path.
 * The kernel never learns what any of them are.
 *
 * Also demonstrated: attenuated delegation, typed suspension + resume, loud
 * bind failure, policy suspend/deny, taint-based denial, cancellation,
 * budget-exceeded + re-grant, and checkpoint -> fresh Kernel instance
 * (journal replay) -> restore -> resume.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Kernel } from './kernel.ts';
import { AttenuationError, BindError, INTERRUPTED, KernelError } from './types.ts';
import type { AxisRequirement, Binding, InvocationOutcome } from './types.ts';

import { mockLlm } from './capabilities/mock-llm.ts';
import { calculatorTool } from './capabilities/calculator-tool.ts';
import { mockMcpServer } from './capabilities/mock-mcp-server.ts';
import { makeCodingAgent } from './capabilities/coding-agent.ts';
import { makeGraphStrategy } from './capabilities/graph-strategy.ts';
import { remoteA2aAgent } from './capabilities/remote-a2a-agent.ts';
import { humanApproval } from './capabilities/human-approval.ts';
import { localModel } from './capabilities/local-model.ts';

// ---------------------------------------------------------------------------
// Setup: deterministic clock, journal in a scratch dir, providers, policies
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const scratch = process.env['KYXO_DEMO_DIR'] ?? mkdtempSync(join(tmpdir(), 'kyxo-demo-'));
const journalPath = join(scratch, 'journal.jsonl');

let tick = 0;
const clock = (): string => new Date(Date.UTC(2026, 7, 15, 12, 0, 0) + tick++ * 1000).toISOString();

function registerAll(k: Kernel): void {
  k.registerCapability(mockLlm);
  k.registerCapability(calculatorTool);
  k.registerCapability(mockMcpServer);
  k.registerCapability(makeCodingAgent({ llm: 'mock-llm', calc: 'calculator' }));
  k.registerCapability(makeGraphStrategy({ calc: 'calculator' }));
  k.registerCapability(remoteA2aAgent);
  k.registerCapability(humanApproval);
  k.registerCapability(localModel);
}

function registerPolicies(k: Kernel): void {
  k.registerPolicyStage({
    name: 'stability-gate', phases: ['bind'],
    evaluate: (ctx) => ctx.manifest.identity.stability === 'deprecated'
      ? { decision: 'deny', reason: `capability '${ctx.capabilityId}' is deprecated` }
      : { decision: 'allow' },
  });
  k.registerPolicyStage({
    name: 'taint-guard', phases: ['invoke'],
    evaluate: (ctx) => ctx.inputTaint.includes('remote:untrusted')
      ? { decision: 'deny', reason: `input carries taint [${ctx.inputTaint.join(', ')}]` }
      : { decision: 'allow' },
  });
  k.registerPolicyStage({
    name: 'human-in-the-loop', phases: ['invoke'],
    evaluate: (ctx) => (ctx.request as { sensitive?: boolean } | undefined)?.sensitive === true
      ? { decision: 'suspend', reason: 'request flagged sensitive', payload: { form: { question: 'Sensitive request — proceed?', options: ['approve', 'reject'] } } }
      : { decision: 'allow' },
  });
}

const kernel = new Kernel({ journalPath, clock });
registerAll(kernel);
registerPolicies(kernel);

const root = kernel.createGrant({
  rights: ['invoke:*'],
  budgets: { tokens: 100_000, moneyCents: 5_000, invocations: 500, spawnDepth: 6 },
  label: 'root',
});
const g = (rights: string[], tokens: number, moneyCents: number, invocations: number, spawnDepth: number, label: string) =>
  kernel.attenuate(root.id, { rights, budgets: { tokens, moneyCents, invocations, spawnDepth }, label });

const gLlm = g(['invoke:mock-llm'], 4000, 100, 20, 1, 'llm-caller');
const gCalc = g(['invoke:calculator'], 10, 10, 20, 1, 'calc-caller');
const gMcp = g(['invoke:mock-mcp'], 10, 10, 10, 1, 'mcp-caller');
const gAgent = g(['invoke:coding-agent', 'invoke:mock-llm', 'invoke:calculator'], 5000, 100, 30, 3, 'agent-runner');
const gGraph = g(['invoke:graph-strategy', 'invoke:calculator'], 100, 50, 20, 2, 'graph-runner');
const gA2a = g(['invoke:remote-a2a'], 100, 50, 10, 1, 'a2a-caller');
const gHuman = g(['invoke:human-approval'], 10, 10, 10, 1, 'approval-seeker');
const gLocal = g(['invoke:local-model'], 1000, 10, 10, 1, 'local-caller');

// ---------------------------------------------------------------------------
// Reporting helpers (journal filtering lives in the demo, not the kernel)
// ---------------------------------------------------------------------------

const short = (v: unknown, n = 120): string => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > n ? s.slice(0, n) + '…' : s;
};
const transitionsOf = (k: Kernel, invId: string): string =>
  ['submitted', ...k.journal().filter((e) => e.kind === 'invocation.transition' && e.invocationId === invId).map((e) => String(e.payload['to']))].join(' → ');
const eventsOf = (k: Kernel, invId: string): number =>
  k.journal().filter((e) => e.invocationId === invId).length;
const chargesOf = (k: Kernel, invId: string): string[] =>
  k.journal().filter((e) => e.kind === 'grant.charged' && e.invocationId === invId)
    .map((e) => `${String(e.payload['grantId'])}${short(e.payload['cost'], 60)}`);
const section = (t: string): void => {
  console.log('\n' + '='.repeat(76) + '\n== ' + t + '\n' + '='.repeat(76));
};

interface RunSpec {
  name: string; capabilityId: string; grantId: string;
  requirements: AxisRequirement[]; request: unknown;
  cellId?: string; resumeWith?: unknown;
}
interface RunRecord { spec: RunSpec; binding: Binding; outcome: InvocationOutcome }

/** THE identical path all eight capabilities go through. */
async function runOne(k: Kernel, spec: RunSpec): Promise<RunRecord> {
  console.log(`\n-- ${spec.name}`);
  const binding = k.bind({ capabilityId: spec.capabilityId, grantId: spec.grantId, requirements: spec.requirements });
  console.log(`   binding ${binding.id}  negotiated=${short(binding.negotiated)}  ignoredAxes=[${binding.ignoredAxes.join(',')}]`);
  let outcome = await k.invoke(binding.id, spec.request, spec.cellId !== undefined ? { cellId: spec.cellId } : {});
  if (INTERRUPTED.includes(outcome.state) && spec.resumeWith !== undefined) {
    console.log(`   suspended (${outcome.state})  payload=${short(outcome.suspension?.payload, 90)}`);
    outcome = await k.resume(outcome.invocationId, spec.resumeWith);
  }
  console.log(`   lifecycle: ${transitionsOf(k, outcome.invocationId)}`);
  console.log(`   journaled events: ${eventsOf(k, outcome.invocationId)}  charges: ${chargesOf(k, outcome.invocationId).join(' ') || '(none yet)'}`);
  console.log(`   final: ${outcome.state}${outcome.output !== undefined ? '  output=' + short(outcome.output) : ''}${outcome.error !== undefined ? '  error=' + outcome.error : ''}`);
  return { spec, binding, outcome };
}

// ---------------------------------------------------------------------------
// 1. All eight capabilities through the identical kernel.invoke() path
// ---------------------------------------------------------------------------

section('1. UNIVERSALITY — eight capabilities, one invoke() path, zero kernel dispatch');
console.log(`journal: ${journalPath}`);

const approvalCell = kernel.createCell('approval-cell');
const LLM_REQS: AxisRequirement[] = [
  { axis: 'reasoning', need: 'tier-at-least', tier: 'summary' },
  { axis: 'toolDialect', need: 'one-of', anyOf: ['kyxo-json', 'anthropic-messages'] },
  { axis: 'streaming', need: 'enabled' },
];

const runs: RunRecord[] = [];
for (const spec of [
  { name: '1/8 raw LLM (mock-llm)', capabilityId: 'mock-llm', grantId: gLlm.id, requirements: LLM_REQS, request: { prompt: 'Write a haiku about kernels' } },
  { name: '2/8 pure tool (calculator)', capabilityId: 'calculator', grantId: gCalc.id, requirements: [{ axis: 'purity', need: 'enabled' }, { axis: 'operations', need: 'present' }] as AxisRequirement[], request: { op: 'add', a: 2, b: 3 } },
  { name: '3/8 MCP server (mock-mcp)', capabilityId: 'mock-mcp', grantId: gMcp.id, requirements: [{ axis: 'toolDialect', need: 'one-of', anyOf: ['mcp'] }, { axis: 'transport', need: 'one-of', anyOf: ['stdio'] }] as AxisRequirement[], request: { method: 'tools/call', name: 'echo', arguments: { text: 'hello kyxo' } } },
  { name: '4/8 harness agent (coding-agent)', capabilityId: 'coding-agent', grantId: gAgent.id, requirements: [{ axis: 'harness', need: 'tier-at-least', tier: 'reactive' }, { axis: 'delegation', need: 'enabled' }] as AxisRequirement[], request: { objective: 'add 2 and 3, then multiply the sum by 7' } },
  { name: '5/8 graph strategy (fan-out+join)', capabilityId: 'graph-strategy', grantId: gGraph.id, requirements: [{ axis: 'parallelism', need: 'tier-at-least', tier: 'fan-out' }] as AxisRequirement[], request: { fanOut: [{ op: 'mul', a: 6, b: 7 }, { op: 'add', a: 20, b: 22 }] } },
  { name: '6/8 remote A2A agent (input-required round trip)', capabilityId: 'remote-a2a', grantId: gA2a.id, requirements: [{ axis: 'sessionModel', need: 'one-of', anyOf: ['a2a-task'] }, { axis: 'statefulness', need: 'tier-at-least', tier: 'task' }] as AxisRequirement[], request: { task: 'compile shipping report' }, resumeWith: { units: 'metric' } },
  { name: '7/8 human approval (left suspended for checkpoint demo)', capabilityId: 'human-approval', grantId: gHuman.id, requirements: [{ axis: 'elicitation', need: 'one-of', anyOf: ['form'] }] as AxisRequirement[], request: { action: 'merge release branch', riskNote: 'production deploy' }, cellId: approvalCell.id },
  { name: '8/8 local model (openai-compat dialect, no reasoning axis)', capabilityId: 'local-model', grantId: gLocal.id, requirements: [{ axis: 'toolDialect', need: 'one-of', anyOf: ['openai-tools'] }, { axis: 'streaming', need: 'enabled' }] as AxisRequirement[], request: { messages: [{ role: 'user', content: 'ping' }] } },
] as RunSpec[]) {
  runs.push(await runOne(kernel, spec));
}

// ---------------------------------------------------------------------------
// 2. Loud bind failure — requiring an axis the manifest does not declare
// ---------------------------------------------------------------------------

section('2. LOUD BIND FAILURE — local-model + reasoning>=trace must be rejected at bind');
let loudBindFailure = false;
try {
  kernel.bind({ capabilityId: 'local-model', grantId: gLocal.id, requirements: [{ axis: 'reasoning', need: 'tier-at-least', tier: 'trace' }] });
  console.log('   !!! bind unexpectedly succeeded');
} catch (err) {
  loudBindFailure = err instanceof BindError;
  console.log(`   BindError (as designed):\n   ${(err as Error).message.split('\n').join('\n   ')}`);
}

// ---------------------------------------------------------------------------
// 3. Attenuated delegation — child grant < parent, violations rejected
// ---------------------------------------------------------------------------

section('3. ATTENUATION — coding agent delegated under a strictly smaller grant');
const agentRun = runs[3] as RunRecord;
const childGrantId = (agentRun.outcome.output as { childGrantId: string }).childGrantId;
const child = kernel.getGrant(childGrantId);
console.log(`   parent ${gAgent.id} initial=${short(gAgent.initial)} remaining=${short(gAgent.budgets)}`);
console.log(`   child  ${child.id} initial=${short(child.initial)} remaining=${short(child.budgets)}`);
console.log(`   root   ${root.id} remaining=${short(root.budgets)}  (child charges flowed up the lineage)`);
const childSmaller =
  (child.initial.tokens as number) < (gAgent.initial.tokens as number) &&
  (child.initial.invocations as number) < (gAgent.initial.invocations as number) &&
  (child.initial.spawnDepth as number) < (gAgent.initial.spawnDepth as number);
let attenuationEnforced = false;
try {
  kernel.attenuate(gAgent.id, { rights: ['invoke:mock-llm'], budgets: { tokens: 999_999, moneyCents: 1, invocations: 1, spawnDepth: 1 }, label: 'greedy' });
} catch (err) {
  attenuationEnforced = err instanceof AttenuationError;
  console.log(`   budget escalation rejected: ${(err as Error).message}`);
}
try {
  kernel.attenuate(gCalc.id, { rights: ['invoke:mock-llm'], budgets: { tokens: 1, moneyCents: 1, invocations: 1, spawnDepth: 0 }, label: 'sneaky' });
  attenuationEnforced = false;
} catch (err) {
  attenuationEnforced = attenuationEnforced && err instanceof AttenuationError;
  console.log(`   rights escalation rejected: ${(err as Error).message}`);
}
attenuationEnforced = attenuationEnforced && childSmaller;

// ---------------------------------------------------------------------------
// 4. Budget charging at commit — exhaustion, then resume under a re-grant
// ---------------------------------------------------------------------------

section('4. BUDGETS — charge at commit; exhaustion interrupts; re-grant resumes');
const tiny = kernel.attenuate(root.id, { rights: ['invoke:mock-llm'], budgets: { tokens: 5, moneyCents: 5, invocations: 5, spawnDepth: 1 }, label: 'tiny' });
const tinyBind = kernel.bind({ capabilityId: 'mock-llm', grantId: tiny.id, requirements: LLM_REQS });
const broke = await kernel.invoke(tinyBind.id, { prompt: 'Write a haiku about kernels' });
console.log(`   with 5-token grant: state=${broke.state}  suspension=${short(broke.suspension?.payload, 150)}`);
const budgetExceededSeen = broke.state === 'budget-exceeded';
const topUp = kernel.attenuate(root.id, { rights: ['invoke:mock-llm'], budgets: { tokens: 500, moneyCents: 10, invocations: 5, spawnDepth: 1 }, label: 'top-up' });
const recovered = await kernel.resume(broke.invocationId, { note: 'operator re-granted' }, { grantId: topUp.id });
console.log(`   resumed under ${topUp.id}: state=${recovered.state}  (re-grant verb — a gap in the spine, see findings)`);
console.log(`   lifecycle: ${transitionsOf(kernel, broke.invocationId)}`);

// ---------------------------------------------------------------------------
// 5. Policy pipeline — suspend (approval) and non-bypassable taint deny
// ---------------------------------------------------------------------------

section('5. POLICY — approval-suspend on sensitive request; taint-based deny');
const calcBinding = (runs[1] as RunRecord).binding;
const sensitive = await kernel.invoke(calcBinding.id, { op: 'mul', a: 11, b: 4, sensitive: true });
console.log(`   sensitive request: state=${sensitive.state} (policy-origin suspension)  payload=${short(sensitive.suspension?.payload, 90)}`);
const approvedRun = await kernel.resume(sensitive.invocationId, { approved: true, note: 'lgtm' });
console.log(`   after approval: state=${approvedRun.state} output=${short(approvedRun.output)}`);
console.log(`   lifecycle: ${transitionsOf(kernel, sensitive.invocationId)}`);
const a2aInvId = (runs[5] as RunRecord).outcome.invocationId;
const taintedEv = kernel.journal().find((e) =>
  e.kind === 'artifact.stored' && e.invocationId === a2aInvId &&
  ((e.payload['artifact'] as { taint: string[] }).taint).includes('remote:untrusted'));
const taintedHash = (taintedEv?.payload['artifact'] as { hash: string }).hash;
const denied = await kernel.invoke(calcBinding.id, { op: 'add', a: 1, b: 1 }, { inputArtifacts: [taintedHash] });
console.log(`   invocation fed remote-tainted artifact ${taintedHash}: state=${denied.state} (${denied.error ?? 'denied by policy'})`);
const policyWorked = sensitive.state === 'approval-required' && approvedRun.state === 'completed' && denied.state === 'rejected';

// ---------------------------------------------------------------------------
// 6. Cancellation of a suspended invocation
// ---------------------------------------------------------------------------

section('6. CANCELLATION — canceling a suspended remote task');
const secondA2a = await kernel.invoke((runs[5] as RunRecord).binding.id, { task: 'second task' });
kernel.cancel(secondA2a.invocationId, 'operator canceled the request');
console.log(`   ${secondA2a.invocationId}: ${transitionsOf(kernel, secondA2a.invocationId)}`);

// ---------------------------------------------------------------------------
// 7. Kind registry + probe (the remaining kernel objects, briefly)
// ---------------------------------------------------------------------------

section('7. KIND REGISTRY + PROBE');
kernel.registerKind({
  name: 'dev.kyxo.research/Objective', version: 'v1',
  validate: (p) => {
    const errs: string[] = [];
    const o = p as { objective?: unknown } | null;
    if (o === null || typeof o !== 'object') errs.push('payload must be an object');
    else if (typeof o.objective !== 'string' || o.objective === '') errs.push('objective: non-empty string required');
    return errs;
  },
});
const objHash = kernel.createKindObject('dev.kyxo.research/Objective', { objective: 'validate kernel universality' });
console.log(`   stored Objective as artifact ${objHash}`);
try {
  kernel.createKindObject('dev.kyxo.research/Objective', { wrong: true });
} catch (err) {
  console.log(`   invalid Kind object rejected loudly: ${(err as Error).message.split('\n')[0]}`);
}
const probeReport = await kernel.probe('calculator');
console.log(`   probe(calculator): ok=${probeReport?.ok} evidence=${short(probeReport?.evidence)}`);

// ---------------------------------------------------------------------------
// 8. Checkpoint -> fresh Kernel (JSONL replay) -> restore -> resume
// ---------------------------------------------------------------------------

section('8. KILL/RESUME — checkpoint, fresh Kernel instance from JSONL, restore, resume');
const humanRun = runs[6] as RunRecord;
const cp = kernel.checkpoint(approvalCell.id);
console.log(`   checkpoint ${cp.id} of ${approvalCell.id} at journal seq ${cp.journalSeq}; pending=[${cp.pending.join(',')}]`);
const rootSnapshot = JSON.stringify(kernel.getGrant(root.id).budgets);
console.log('   --- simulating process death: constructing a brand-new Kernel from the journal file ---');
const kernel2 = new Kernel({ journalPath, clock, replay: true });
registerAll(kernel2);
registerPolicies(kernel2);
const rootReplayed = JSON.stringify(kernel2.getGrant(root.id).budgets);
const replayMatches = rootSnapshot === rootReplayed;
console.log(`   replayed ${kernel2.journal().length} journal records; root grant remaining matches: ${replayMatches} (${rootReplayed})`);
let restoreGate = false;
try {
  await kernel2.resume(humanRun.outcome.invocationId, { decision: 'approve' });
} catch (err) {
  restoreGate = err instanceof KernelError;
  console.log(`   resume before restore correctly refused: ${(err as Error).message}`);
}
const restored = kernel2.restore(cp.id);
console.log(`   restored ${restored.cellId}; pending invocations: [${restored.pending.join(',')}]`);
const finalHuman = await kernel2.resume(humanRun.outcome.invocationId, { decision: 'approve', note: 'ship it' });
console.log(`   resumed across instances: state=${finalHuman.state} output=${short(finalHuman.output)}`);
console.log(`   lifecycle (kernel2 view): ${transitionsOf(kernel2, finalHuman.invocationId)}`);
const resumeAcrossInstance = restoreGate && finalHuman.state === 'completed'
  && (finalHuman.output as { approved?: boolean }).approved === true;

// ---------------------------------------------------------------------------
// FINAL ASSERTIONS
// ---------------------------------------------------------------------------

section('FINAL ASSERTIONS');

function scanCoreRule(): { pass: boolean; detail: string } {
  const banned: Array<{ label: string; re: RegExp }> = [
    { label: 'sw-itch statement', re: /\bswitch\b/i },
    { label: 'kind equality dispatch', re: /\bkind\s*[!=]==/i },
    { label: 'type equality dispatch', re: /\btype\s*[!=]==/i },
    { label: 'capability-class vocabulary', re: /\b(category|capabilitykind|capabilitytype|providertype|providerkind)\b/i },
    { label: 'instanceof-provider dispatch', re: /instanceof\s+[A-Za-z]*provider/i },
    { label: 'capability name literal in kernel', re: /'(mock-llm|calculator|mock-mcp|coding-agent|graph-strategy|remote-a2a|human-approval|local-model|llm|mcp|a2a)'/i },
  ];
  const hits: string[] = [];
  for (const f of ['kernel.ts', 'types.ts']) {
    const src = readFileSync(join(here, f), 'utf8');
    for (const b of banned) if (b.re.test(src)) hits.push(`${f}: ${b.label}`);
  }
  return { pass: hits.length === 0, detail: hits.length === 0 ? 'kernel.ts+types.ts contain no capability-identity dispatch' : hits.join('; ') };
}

const uniform = runs.length === 8
  && runs.every((r) => Object.keys(r.binding.negotiated).length >= 1)
  && runs.every((r) => transitionsOf(kernel, r.outcome.invocationId).includes('→'))
  && runs.filter((r) => r.outcome.state === 'completed').length === 7
  && (runs[6] as RunRecord).outcome.state === 'approval-required';

const rootB = kernel.getGrant(root.id).budgets;
const budgetCharged = (rootB.tokens as number) < 100_000 && (rootB.invocations as number) < 500
  && budgetExceededSeen && recovered.state === 'completed' && replayMatches;

const core = scanCoreRule();
const checks: Array<{ name: string; pass: boolean; detail: string }> = [
  { name: 'no-type-dispatch', pass: core.pass, detail: core.detail },
  { name: 'all-eight-uniform', pass: uniform, detail: '8 capabilities, one invoke() path; 7 completed + 1 held for cross-instance resume' },
  { name: 'attenuation-enforced', pass: attenuationEnforced, detail: 'child<parent verified; budget & rights escalations threw AttenuationError' },
  { name: 'budget-charged', pass: budgetCharged, detail: `root remaining ${short(rootB)}; exhaustion interrupted; charges survived replay` },
  { name: 'resume-across-instance', pass: resumeAcrossInstance, detail: 'checkpoint -> new Kernel(replay) -> restore gate -> resume -> completed' },
  { name: 'loud-bind-failure', pass: loudBindFailure, detail: 'missing required axis raised BindError at bind time' },
  { name: 'policy-pipeline', pass: policyWorked, detail: 'suspend->approve->complete; taint deny non-bypassable' },
];
let allPass = true;
for (const c of checks) {
  console.log(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} ${c.detail}`);
  if (!c.pass) allPass = false;
}
console.log(`\n${allPass ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED'} — journal at ${journalPath} (${kernel2.journal().length} records)`);
process.exitCode = allPass ? 0 : 1;
