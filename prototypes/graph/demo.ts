/**
 * demo.ts — dynamic-graph orchestration on the UNMODIFIED kernel invoke path
 * (plus one 5-line discovery hook; see findings).
 *
 * Shows and asserts:
 *   - plan-version lineage v1 -> Evidence -> v2, with CAS provenance links,
 *   - the parallel interleaving of the two gather branches from the journal,
 *   - join-barrier ordering (join submitted only after both branches commit),
 *   - verification fail -> pass across the plan mutation,
 *   - nodes bound BY REQUIREMENT at execution time (who won, who lost, why),
 *   - delta re-execution via deterministic idempotency keys (memoization),
 *   - mutation causation (replan caused by the graph run, fed the evidence),
 *   - Plan Kind schema validation at the kernel (CRD-style).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../kernel/kernel.ts';
import type { KernelEvent } from '../kernel/types.ts';
import { planKind, PLAN_KIND } from './plan-kind.ts';
import type { Plan } from './plan-kind.ts';
import { fmtRequirement, makeDynamicGraphStrategy } from './graph-strategy.ts';
import type { GraphRunOutput, NodeRunRecord, PlanExecutionRecord } from './graph-strategy.ts';
import { archiveScanner, liveProbe } from './capabilities/gatherers.ts';
import { tallyDesk } from './capabilities/tally-desk.ts';
import { sourceReconciler } from './capabilities/reconciler.ts';
import { reportAuditor } from './capabilities/report-auditor.ts';
import { mockPlanner } from './capabilities/mock-planner.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const scratch = process.env['KYXO_GRAPH_DEMO_DIR'] ?? mkdtempSync(join(tmpdir(), 'kyxo-graph-'));
const journalPath = join(scratch, 'graph-journal.jsonl');

let tick = 0;
const clock = (): string => new Date(Date.UTC(2026, 7, 16, 9, 0, 0) + tick++ * 250).toISOString();

const kernel = new Kernel({ journalPath, clock });
// Registration order is deliberate: weaker candidates first, so requirement
// resolution visibly REJECTS them before finding each winner.
kernel.registerCapability(liveProbe);
kernel.registerCapability(archiveScanner);
kernel.registerCapability(tallyDesk);
kernel.registerCapability(sourceReconciler);
kernel.registerCapability(reportAuditor);
kernel.registerCapability(mockPlanner);
kernel.registerCapability(makeDynamicGraphStrategy());
kernel.registerKind(planKind);

const root = kernel.createGrant({
  rights: ['invoke:*'],
  budgets: { tokens: 100_000, moneyCents: 5_000, invocations: 500, spawnDepth: 6 },
  label: 'root',
});
const gGraph = kernel.attenuate(root.id, {
  rights: ['invoke:*'],
  budgets: { tokens: 6_000, moneyCents: 300, invocations: 60, spawnDepth: 4 },
  label: 'graph-runner',
});

// ---------------------------------------------------------------------------
// Reporting helpers (journal projections live in the demo, not the kernel)
// ---------------------------------------------------------------------------

const short = (v: unknown, n = 110): string => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > n ? s.slice(0, n) + '…' : s;
};
const section = (t: string): void => {
  console.log('\n' + '='.repeat(76) + '\n== ' + t + '\n' + '='.repeat(76));
};
const journal = (): readonly KernelEvent[] => kernel.journal();
const seqsOf = (invId: string, kind?: string): number[] =>
  journal().filter((e) => e.invocationId === invId && (kind === undefined || e.kind === kind)).map((e) => e.seq);
const completionSeq = (invId: string): number =>
  journal().find((e) => e.kind === 'invocation.transition' && e.invocationId === invId && e.payload['to'] === 'completed')?.seq ?? -1;
const submissionSeq = (invId: string): number =>
  journal().find((e) => e.kind === 'invocation.submitted' && e.invocationId === invId)?.seq ?? -1;

function printPlan(plan: Plan): void {
  console.log(`   plan ${plan.planId} v${plan.version}  gate='${plan.gate}'${plan.basedOn !== undefined ? `  basedOn=${plan.basedOn}` : ''}${plan.becauseOf !== undefined ? `  becauseOf=[${plan.becauseOf.join(', ')}]` : ''}`);
  for (const n of plan.nodes) console.log(`     node ${n.id.padEnd(16)} ${n.join !== undefined ? '[join:all] ' : ''}requires ${n.requires.map(fmtRequirement).join(', ')}`);
  for (const e of plan.edges) console.log(`     edge ${e.from} -> ${e.to}${e.when !== undefined ? `  when ${e.when.path}==${JSON.stringify(e.when.equals)}` : ''}`);
}

function walkProvenance(hash: string, indent: string, depth: number): void {
  const a = kernel.getArtifact(hash);
  const by = a.provenance.producedBy;
  const cap = by === undefined ? '(external)' : kernel.getInvocation(by).capabilityId;
  console.log(`${indent}${hash}  producedBy=${by ?? '-'} (${cap})`);
  if (depth <= 0) return;
  for (const h of a.provenance.inputs) walkProvenance(h, indent + '    ', depth - 1);
}

// ---------------------------------------------------------------------------
// 0. Discovery + run
// ---------------------------------------------------------------------------

section('0. SETUP — capability registry via the discovery hook');
console.log(`journal: ${journalPath}`);
for (const m of kernel.listCapabilities()) {
  console.log(`   ${m.identity.id.padEnd(18)} v${m.identity.version.padEnd(7)} axes: ${Object.keys(m.axes).join(', ')}`);
}

const OBJECTIVE = 'produce a verified count of active beacon sites in sector 7';

section('1. RUN — dynamic-graph strategy through the ordinary invoke() path');
const binding = kernel.bind({
  capabilityId: 'dynamic-graph', grantId: gGraph.id,
  requirements: [
    { axis: 'parallelism', need: 'tier-at-least', tier: 'fan-out' },
    { axis: 'planning', need: 'tier-at-least', tier: 'replanning' },
    { axis: 'verificationGate', need: 'enabled' },
  ],
});
console.log(`   binding ${binding.id}  negotiated=${short(binding.negotiated)}`);
const outcome = await kernel.invoke(binding.id, { objective: OBJECTIVE });
if (outcome.state !== 'completed') {
  console.log(`   RUN DID NOT COMPLETE: state=${outcome.state} error=${outcome.error ?? '(none)'}`);
  console.log('   last journal records:');
  for (const e of journal().slice(-12)) console.log(`     seq ${e.seq} ${e.kind} ${short(e.payload, 140)}`);
  process.exit(1);
}
const out = outcome.output as GraphRunOutput;
console.log(`   state=${outcome.state}; run narrative (journal progress projection):`);
for (const e of journal().filter((e) => e.kind === 'invocation.progress' && e.invocationId === outcome.invocationId)) {
  console.log(`   [seq ${String(e.seq).padStart(3)}] ${String(e.payload['note'])}`);
}

const execV1 = out.executions[0] as PlanExecutionRecord;
const execV2 = out.executions[1] as PlanExecutionRecord;
const runOf = (exec: PlanExecutionRecord, nodeId: string): NodeRunRecord =>
  exec.runs.find((r) => r.nodeId === nodeId) as NodeRunRecord;

// ---------------------------------------------------------------------------
// 2. Plan-version lineage: v1 -> evidence -> v2 with CAS provenance
// ---------------------------------------------------------------------------

section('2. PLAN LINEAGE — v1 -> Evidence -> v2, provenance in the CAS');
const l1 = out.lineage[0]!;
const l2 = out.lineage[1]!;
const planV1 = kernel.getArtifact(l1.artifact).content as Plan;
const planV2 = kernel.getArtifact(l2.artifact).content as Plan;
const evidenceHash = out.verdicts[0]!.evidenceArtifact as string;
printPlan(planV1);
console.log('   --- verification fail produced Evidence; planner mutated the plan ---');
printPlan(planV2);
console.log(`\n   Plan v1 ${l1.artifact} (producedBy ${l1.producedByInvocation})`);
console.log(`      └─ executed; gate verdict FAIL -> Evidence ${evidenceHash}`);
console.log(`           └─ replan -> Plan v2 ${l2.artifact} (producedBy ${l2.producedByInvocation})`);
console.log('   provenance walk of the Plan v2 artifact (links back through evidence to the data):');
walkProvenance(l2.artifact, '   ', 3);
const planV2Prov = kernel.getArtifact(l2.artifact).provenance;
const evidenceProv = kernel.getArtifact(evidenceHash).provenance;
const lineageOk =
  out.lineage.length === 2 &&
  planV2.basedOn === l1.artifact &&
  (planV2.becauseOf ?? []).includes(evidenceHash) &&
  planV2Prov.inputs.includes(evidenceHash) && planV2Prov.inputs.includes(l1.artifact) &&
  evidenceProv.producedBy === out.verdicts[0]!.verifierInvocationId;

// ---------------------------------------------------------------------------
// 3. Parallel fan-out interleaving (journal projection)
// ---------------------------------------------------------------------------

section('3. PARALLEL FAN-OUT — the two gather branches interleave in the journal');
const invA = runOf(execV1, 'gather-archive').invocationId;
const invB = runOf(execV1, 'gather-live').invocationId;
for (const e of journal().filter((e) => e.invocationId === invA || e.invocationId === invB)) {
  const who = e.invocationId === invA ? 'gather-archive' : 'gather-live  ';
  const what = e.kind === 'invocation.progress' ? `progress: ${String(e.payload['note'])}`
    : e.kind === 'invocation.transition' ? `transition: ${String(e.payload['from'])} -> ${String(e.payload['to'])}`
    : e.kind;
  console.log(`   seq ${String(e.seq).padStart(3)}  ${who}  ${what}`);
}
const aProg = seqsOf(invA, 'invocation.progress');
const bProg = seqsOf(invB, 'invocation.progress');
const interleaved =
  aProg.length >= 2 && bProg.length >= 2 &&
  bProg.some((s) => s > Math.min(...aProg) && s < Math.max(...aProg)) &&
  aProg.some((s) => s > Math.min(...bProg) && s < Math.max(...bProg));
console.log(`   interleaved: ${interleaved} (each branch progressed inside the other's lifetime)`);

// ---------------------------------------------------------------------------
// 4. Join barrier
// ---------------------------------------------------------------------------

section('4. JOIN BARRIER — join-tally submitted only after BOTH branches commit');
const invJoin = runOf(execV1, 'join-tally').invocationId;
const joinSub = submissionSeq(invJoin);
const aDone = completionSeq(invA);
const bDone = completionSeq(invB);
console.log(`   gather-archive completed at seq ${aDone}; gather-live completed at seq ${bDone}`);
console.log(`   join-tally submitted at seq ${joinSub} (> max(${aDone}, ${bDone}))`);
const joinBarrierOk = joinSub > Math.max(aDone, bDone) && joinSub >= 0;

// ---------------------------------------------------------------------------
// 5. Verification fail -> pass; edge condition on the fix-up edge
// ---------------------------------------------------------------------------

section('5. VERIFICATION — fail on v1, pass on v2 after the fix-up node');
for (const v of out.verdicts) {
  console.log(`   plan v${v.planVersion}: verdict=${v.verdict}  evidence=${v.evidenceArtifact ?? '-'}`);
  for (const p of v.problems) console.log(`       problem: ${p}`);
}
for (const c of execV2.conditions) {
  console.log(`   edge condition ${c.from} -> ${c.to}: satisfied=${c.satisfied} (${c.detail})`);
}
console.log(`   final report: ${short(out.finalReport, 200)}`);
const failThenPass =
  out.verdicts.length === 2 &&
  out.verdicts[0]!.verdict === 'fail' && out.verdicts[0]!.problems.length === 2 &&
  out.verdicts[1]!.verdict === 'pass' && out.verdicts[1]!.problems.length === 0;
const conditionOk = execV2.conditions.some((c) => c.from === 'fixup-reconcile' && c.to === 'verify' && c.satisfied);

// ---------------------------------------------------------------------------
// 6. Requirement -> binding resolution (who won, who lost, why)
// ---------------------------------------------------------------------------

section('6. RESOLUTION — nodes bound by requirement at execution time');
const expectedWinners: Readonly<Record<string, string>> = {
  'gather-archive': 'archive-scanner',
  'gather-live': 'live-probe',
  'join-tally': 'tally-desk',
  'verify': 'report-auditor',
  'fixup-reconcile': 'source-reconciler',
};
let winnersOk = out.plannerCapability === 'mock-planner';
let sawTierRejection = false;
for (const exec of out.executions) {
  console.log(`   plan v${exec.planVersion}: waves ${exec.waves.map((w) => `[${w.join(', ')}]`).join(' -> ')}`);
  for (const r of exec.runs) {
    console.log(`     ${r.nodeId.padEnd(16)} WON by '${r.winner}'  negotiated=${short(r.negotiated, 80)}`);
    for (const rej of r.rejected) {
      console.log(`        rejected '${rej.capabilityId}': ${rej.detail}`);
      if (rej.detail.includes('requires tier >=')) sawTierRejection = true;
    }
    if (expectedWinners[r.nodeId] !== r.winner) winnersOk = false;
  }
}
winnersOk = winnersOk && sawTierRejection;

// ---------------------------------------------------------------------------
// 7. Mutation causation + correlation
// ---------------------------------------------------------------------------

section('7. CAUSATION — the mutation is journaled as caused by this run + its evidence');
const replanInv = kernel.getInvocation(l2.producedByInvocation);
console.log(`   replan invocation ${replanInv.id}: capability=${replanInv.capabilityId}`);
console.log(`     causationId=${replanInv.causationId ?? '-'} (graph run is ${outcome.invocationId})`);
console.log(`     correlationId=${replanInv.correlationId} (graph run correlation)`);
console.log(`     inputArtifacts=[${replanInv.inputArtifacts.join(', ')}] (evidence + prior plan)`);
const allChildInvs = [
  ...out.executions.flatMap((e) => e.runs.map((r) => r.invocationId)),
  l1.producedByInvocation, l2.producedByInvocation,
];
const causationOk =
  replanInv.causationId === outcome.invocationId &&
  replanInv.inputArtifacts.includes(evidenceHash) &&
  allChildInvs.every((id) => kernel.getInvocation(id).correlationId === outcome.invocationId);
console.log(`   all ${allChildInvs.length} child invocations share the run's correlationId: ${causationOk}`);

// ---------------------------------------------------------------------------
// 8. Delta execution — memoization via deterministic idempotency keys
// ---------------------------------------------------------------------------

section('8. DELTA — v2 re-execution memoizes unchanged nodes, only the delta runs');
console.log('   node               v1 invocation   v2 invocation   memoized');
const memoRows: Array<{ node: string; memo: boolean; same: boolean }> = [];
for (const r2 of execV2.runs) {
  const r1 = execV1.runs.find((r) => r.nodeId === r2.nodeId);
  console.log(`   ${r2.nodeId.padEnd(18)} ${(r1?.invocationId ?? '(new)').padEnd(15)} ${r2.invocationId.padEnd(15)} ${r2.memoized}`);
  memoRows.push({ node: r2.nodeId, memo: r2.memoized, same: r1?.invocationId === r2.invocationId });
}
const childGrant = kernel.getGrant(out.childGrantId);
const invocationsUsed = (childGrant.initial.invocations as number) - (childGrant.budgets.invocations as number);
console.log(`   child grant ${childGrant.id}: invocation budget used = ${invocationsUsed} (2 planner + 4 v1 nodes + 2 v2 delta nodes;`);
console.log('   memoized nodes were deduped BEFORE the budget commit point — the delta is all that was charged)');
const memoized = memoRows.filter((m) => m.memo);
const fresh = memoRows.filter((m) => !m.memo);
const deltaOk =
  memoized.length === 3 && memoized.every((m) => m.same) &&
  ['gather-archive', 'gather-live', 'join-tally'].every((n) => memoized.some((m) => m.node === n)) &&
  fresh.length === 2 && ['fixup-reconcile', 'verify'].every((n) => fresh.some((m) => m.node === n)) &&
  invocationsUsed === 8;

// ---------------------------------------------------------------------------
// 9. Plan Kind at the kernel (CRD-style schema validation)
// ---------------------------------------------------------------------------

section('9. PLAN KIND — kernel-validated storage; malformed plans rejected loudly');
const promoted1 = kernel.createKindObject(PLAN_KIND, planV1);
const promoted2 = kernel.createKindObject(PLAN_KIND, planV2);
console.log(`   promoted plan v1 as Kind object -> ${promoted1} (same CAS hash: ${promoted1 === l1.artifact})`);
console.log(`   promoted plan v2 as Kind object -> ${promoted2} (same CAS hash: ${promoted2 === l2.artifact})`);
let kindGateOk = promoted1 === l1.artifact && promoted2 === l2.artifact;
try {
  kernel.createKindObject(PLAN_KIND, {
    planId: 'bad', version: 2, objective: 'x', gate: 'b',
    nodes: [
      { id: 'a', requires: [{ axis: 'x', need: 'present' }], input: {} },
      { id: 'b', requires: [{ axis: 'x', need: 'present' }], input: {} },
      { id: 'c', requires: [], input: {} },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'c', to: 'b' }],
  });
  kindGateOk = false;
  console.log('   !!! malformed plan was accepted');
} catch (err) {
  console.log('   malformed plan rejected loudly:');
  for (const line of (err as Error).message.split('\n')) console.log(`     ${line}`);
}

// ---------------------------------------------------------------------------
// FINAL ASSERTIONS
// ---------------------------------------------------------------------------

section('FINAL ASSERTIONS');
const checks: Array<{ name: string; pass: boolean; detail: string }> = [
  { name: 'bound-by-requirement', pass: winnersOk, detail: 'every node resolved to the expected winner via axis negotiation; tier rejections observed' },
  { name: 'parallel-interleaving', pass: interleaved, detail: 'both gather branches progressed inside each other\'s journal lifetime' },
  { name: 'join-barrier', pass: joinBarrierOk, detail: `join submitted (seq ${joinSub}) strictly after both branch commits (${aDone}, ${bDone})` },
  { name: 'verify-fail-then-pass', pass: failThenPass, detail: 'v1 gate: fail with 2 problems; v2 gate: pass with 0' },
  { name: 'plan-lineage-provenance', pass: lineageOk, detail: 'v2.basedOn=v1 artifact; v2.becauseOf + CAS inputs include the Evidence; evidence producedBy the verifier' },
  { name: 'mutation-causation', pass: causationOk, detail: 'replan caused by the graph invocation, fed the evidence artifact; one correlation across the run' },
  { name: 'delta-memoized', pass: deltaOk, detail: '3 unchanged nodes reused v1 invocations (same ids, no re-charge); only fixup+verify ran; 8 invocation units charged' },
  { name: 'edge-condition', pass: conditionOk, detail: 'fixup->verify edge condition (reconciled==true) evaluated and satisfied' },
  { name: 'plan-kind-gate', pass: kindGateOk, detail: 'plan versions promoted as Kind objects (same CAS hash); malformed plan rejected with schema problems' },
  { name: 'completion', pass: outcome.state === 'completed' && (out.finalReport as { reconciled?: boolean }).reconciled === true, detail: 'strategy completed with a reconciled, verified report' },
];
let allPass = true;
for (const c of checks) {
  console.log(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} ${c.detail}`);
  if (!c.pass) allPass = false;
}
console.log(`\n${allPass ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED'} — journal at ${journalPath} (${journal().length} records)`);
process.exitCode = allPass ? 0 : 1;
