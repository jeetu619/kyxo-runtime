/**
 * Capability universality under the FINALIZED semantics (mission PART 10).
 *
 * The phase-1 gate asked "can eight heterogeneous constructs share one invocation
 * path?" This suite asks the harder question: do they still share it once commit
 * barriers, uncertainty, dedup, forks and grants are real? Plus the static check that
 * the kernel never branches on capability identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { Kernel } from '../src/kernel.ts';
import { Storage } from '../src/storage.ts';
import { assertInvariants } from '../src/invariants.ts';
import { ALL_CAPABILITIES, PaymentCapability } from '../src/capabilities.ts';
import type { PolicyStage } from '../src/types.ts';

function setup() {
  const storage = new Storage();
  const k = new Kernel(storage);
  const pay = new PaymentCapability();
  for (const c of ALL_CAPABILITIES) k.register(c);
  k.register(pay);
  return { k, storage, pay };
}

test('eight heterogeneous constructs traverse one invocation path', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, {
    rights: ['compute', 'write', 'remote', 'pay', 'approve'],
    limits: { invocations: 60, spawnDepth: 3, tokens: 100_000 },
  });

  const results: Record<string, string> = {};

  // 1 raw LLM · 2 tool · 3 MCP server · 4 coding agent · 5 graph strategy
  results['llm'] = (await k.invoke(e, 'llm.mock', { ask: 'why' }, g, { step: '1' })).state;
  results['tool'] = (await k.invoke(e, 'tool.calc', { a: 2, b: 3 }, g, { step: '2' })).state;
  results['mcp'] = (await k.invoke(e, 'mcp.files', { path: 'p', content: 'c' }, g, { step: '3' })).state;
  results['agent'] = (await k.invoke(e, 'agent.coder', { task: 't' }, g, { step: '4' })).state;
  results['graph'] = (await k.invoke(e, 'strategy.graph', { run: 1 }, g, { step: '5' })).state;

  // 6 opaque remote (external, idempotent)
  results['remote'] = (await k.invoke(e, 'remote.a2a', { task: 'x' }, g, { step: '6' })).state;

  // 7 human approver — suspends, then resumes with a typed payload
  const human = await k.invoke(e, 'human.approval', { question: 'ship?' }, g, { step: '7' });
  assert.equal(human.state, 'suspended');
  const resumed = await k.resumeInvocation(e, human.invocationId, { approved: true }, g);
  results['human'] = resumed.state;

  // 8 local/open model
  results['local'] = (await k.invoke(e, 'llm.local', { ask: 'hi' }, g, { step: '8' })).state;

  assert.deepEqual(results, {
    llm: 'completed', tool: 'completed', mcp: 'completed', agent: 'completed',
    graph: 'completed', remote: 'completed', human: 'completed', local: 'completed',
  });
  assertInvariants({ kernel: k, storage }, 'eight constructs');
});

test('NO kernel source branches on capability identity', () => {
  // THIS GATE MUST GLOB, NEVER NAME FILES.
  //
  // It previously read exactly `src/kernel.ts` and `src/types.ts`. Wave S1 added a second
  // kernel — `s1-kernel.ts`, `s1-fold.ts`, `s1-types.ts`, `s1-invariants.ts` — and the gate
  // silently kept passing on the two files it had been told about. An independent reviewer
  // injected four textbook violations into `s1-kernel.ts` (a literal capability-id branch,
  // `kind === 'agent'`, a `capabilityType` identifier, a provider-name prefix branch) and
  // all 175 tests passed, including the CI step named after this very invariant.
  //
  // Enumerating files is how a guard rots: the next kernel is added by someone who does
  // not know this list exists. Globbing means new source is covered by default and opting
  // OUT is the deliberate act.
  const dir = new URL('../src/', import.meta.url);
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    // Capability fixtures legitimately name themselves; they are userland, not kernel.
    .filter((f) => f !== 'capabilities.ts');

  assert.ok(sources.length >= 6, `expected the whole kernel surface, saw ${String(sources.length)} files`);
  // Both kernels must be in scope. If a rename drops one, this fails rather than passing quietly.
  for (const required of ['kernel.ts', 'types.ts', 's1-kernel.ts', 's1-fold.ts', 's1-types.ts']) {
    assert.ok(sources.includes(required), `the identity gate must cover ${required}`);
  }

  const capabilityIds = [...ALL_CAPABILITIES.map((c) => c.manifest.id), 'payment.charge'];
  // No conceptual-type branching. (Effect classes and declared traits are permitted:
  // they are negotiated properties, not identities.)
  const forbidden = [
    // Comparing ANYTHING to a conceptual-type name. Deliberately not anchored to a
    // `kind` identifier: the first draft of this rule was `/\bkind\s*===\s*.../` and
    // `capKind === 'agent'` walked straight through it, because \b does not match inside
    // a camelCase word. What is forbidden is the question, not the variable holding it.
    /===\s*['"](agent|tool|model|harness|human|remote)['"]/i,
    /capabilityType/i,
    /instanceof\s+\w*(Agent|Tool|Model)\b/,
    // Branching on who the provider is, by name prefix, is provider identity by another route.
    /capabilityId\s*\.\s*(startsWith|endsWith|includes|match)\s*\(/,
    /\bprovider(Id|Name)\s*===/i,
  ];

  for (const file of sources) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    // Strip comments: prose may legitimately discuss `kind === 'agent'` to explain the rule.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    for (const id of capabilityIds) {
      assert.ok(!code.includes(`'${id}'`), `${file} must not name capability ${id}`);
    }
    for (const re of forbidden) {
      assert.ok(!re.test(code), `${file} contains forbidden identity branching: ${String(re)}`);
    }
  }
});

test('a malicious capability cannot reach the kernel, the journal, or authority', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute'], limits: { invocations: 10, spawnDepth: 1 } });

  const out = await k.invoke(e, 'evil.bypass', { probe: true }, g, { step: 'evil', requiresEvidence: true });

  // It claimed success while proposing failing evidence: the gate must overrule it.
  assert.equal(out.state, 'failed', 'a capability cannot self-certify success (I17)');
  assert.equal(out.error, 'verification-failed');

  // Its artifact was staged but never promoted, because the outcome failed the gate.
  const artifacts = k.events(e).filter((x) => x.kind === 'artifact.produced');
  assert.equal(artifacts.length, 0, 'staged artifacts of a failed gate are discarded, not committed');

  // The context exposed nothing dangerous.
  const reachable = ((out as { output?: unknown }).output ?? {}) as { reachableKeys?: string[] };
  const dangerous = (reachable.reachableKeys ?? []).filter((key) =>
    ['kernel', 'journal', 'storage', 'grants', 'commit', 'append'].includes(key));
  assert.deepEqual(dangerous, [], 'InvokeCtx must expose no kernel surface');
  assertInvariants({ kernel: k, storage }, 'malicious capability');
});

test('a deny-class policy stage cannot be bypassed by any capability', async () => {
  const { k, storage } = setup();
  const denyExternal: PolicyStage = {
    name: 'no-external-effects',
    denyClass: true,
    evaluate: ({ effectClass, phase }) =>
      phase === 'admission' && effectClass !== 'pure' && effectClass !== 'local'
        ? { decision: 'deny', reason: 'external effects are forbidden by policy' }
        : { decision: 'allow' },
  };
  k.addPolicy(denyExternal);

  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['remote', 'pay', 'compute'], limits: { invocations: 20, spawnDepth: 2 } });

  await assert.rejects(() => k.invoke(e, 'remote.a2a', { task: 'x' }, g, { step: 'r' }));
  await assert.rejects(() => k.invoke(e, 'payment.charge', { amount: 1 }, g, { step: 'p' }));
  // Pure work is unaffected.
  assert.equal((await k.invoke(e, 'tool.calc', { a: 1, b: 1 }, g, { step: 'c' })).state, 'completed');

  const denials = k.events(e).filter((x) => x.kind === 'policy.denied');
  assert.equal(denials.length, 2, 'every denial is journaled');
  assertInvariants({ kernel: k, storage }, 'deny-class policy');
});

test('heterogeneous capabilities survive checkpoint, fork and recovery identically', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['compute', 'write', 'remote'], limits: { invocations: 40, spawnDepth: 2 } });

  await k.invoke(e, 'llm.mock', { ask: 'a' }, g, { step: 'a' });
  await k.invoke(e, 'mcp.files', { path: 'f', content: 'v' }, g, { step: 'b' });
  await k.invoke(e, 'remote.a2a', { task: 't' }, g, { step: 'c' });
  const cp = k.checkpoint(e);

  const rec = Kernel.recover(storage, ALL_CAPABILITIES);
  assertInvariants({ kernel: rec.kernel, storage }, 'recovery with mixed capability classes');
  assert.equal(rec.kernel.resumeFromCheckpoint(cp.id).consistent, true);

  const fork = rec.kernel.fork(cp.id, { dispositions: {} });
  assert.equal(rec.kernel.state(fork).cell.get('file:f'), 'v', 'forked state is capability-agnostic');
  assertInvariants({ kernel: rec.kernel, storage }, 'fork with mixed capability classes');
});

test('the commit gate survives suspension and resume (regression: docs/20 F-10)', async () => {
  const { k, storage } = setup();
  const e = k.createExecution();
  const g = k.issueGrant(e, { rights: ['approve'], limits: { invocations: 10, spawnDepth: 1 } });

  // human.approval suspends first, then on resume proposes evidence. Resume with a
  // REJECTION: the gate must refuse the outcome even though the provider returns ok.
  const first = await k.invoke(e, 'human.approval', { question: 'ship?' }, g, {
    step: 'gated', requiresEvidence: true,
  });
  assert.equal(first.state, 'suspended');

  const resumed = await k.resumeInvocation(e, first.invocationId, { approved: false }, g);
  assert.equal(resumed.state, 'failed', 'a gate held only in call options is dropped by the resume path');
  assert.equal(resumed.error, 'verification-failed');

  const admitted = k.events(e).find((x) => x.kind === 'invocation.admitted')!;
  assert.equal(admitted.payload['requiresEvidence'], true, 'the gate is journaled at admission');
  assertInvariants({ kernel: k, storage }, 'gate across suspension');
});
