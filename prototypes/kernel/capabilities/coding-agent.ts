/**
 * coding-agent.ts — a mini harness-driven agent built ON the kernel: it loops
 * model -> tool -> model through kernel bindings and terminates when the model
 * emits no tool call. Demonstrates delegation under an ATTENUATED grant: the
 * child grant it mints is strictly smaller than the grant it was invoked with,
 * and every child charge flows up the grant lineage.
 * The "agent" is a configuration + behaviour, not a kernel object (spine §2).
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface AgentRequest { readonly objective?: string }
interface LlmOutput { readonly text?: string; readonly toolCall?: { op: string; a: number; b: number } }

export function makeCodingAgent(deps: { readonly llm: string; readonly calc: string }): CapabilityProvider {
  const identity = { id: 'coding-agent', version: '0.1.0', stability: 'experimental' } as const;
  return {
    identity,
    manifest: {
      identity,
      summary: 'Reactive harness: model->tool loop over kernel bindings, no-tool-call terminates.',
      axes: {
        harness: { shape: 'tiered', tier: 'reactive', ladder: ['scripted', 'reactive', 'plan-execute'] },
        delegation: { shape: 'flag', enabled: true },
        streaming: { shape: 'flag', enabled: false },
      },
      experimental: { terminationPolicy: 'no-pending-tool-call' },
      extensions: { 'dev.kyxo.harness': { maxTurns: 6, delegatesTo: [deps.llm, deps.calc] } },
    },

    async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
      const objective = ((request ?? {}) as AgentRequest).objective ?? '(none)';
      // Attenuated delegation: child grant strictly smaller than what we hold.
      const child = ctx.kernel.attenuate(ctx.grantId, {
        rights: [`invoke:${deps.llm}`, `invoke:${deps.calc}`],
        budgets: { tokens: 2000, moneyCents: 20, invocations: 10, spawnDepth: 1 },
        label: `coding-agent child of ${ctx.grantId}`,
      });
      yield { op: 'progress', note: `attenuated child grant ${child.id} (tokens 2000, invocations 10) from ${ctx.grantId}` };
      const llm = ctx.kernel.bind({
        capabilityId: deps.llm, grantId: child.id,
        requirements: [
          { axis: 'reasoning', need: 'tier-at-least', tier: 'summary' },
          { axis: 'toolDialect', need: 'one-of', anyOf: ['kyxo-json'] },
        ],
      });
      const calc = ctx.kernel.bind({
        capabilityId: deps.calc, grantId: child.id,
        requirements: [{ axis: 'purity', need: 'enabled' }, { axis: 'operations', need: 'present' }],
      });

      let transcript = `OBJECTIVE: ${objective}`;
      for (let turn = 1; turn <= 6; turn++) {
        yield { op: 'progress', note: `turn ${turn}: invoking model` };
        const r = await ctx.kernel.invoke(llm.id, { prompt: transcript, tools: [deps.calc] }, { causationId: ctx.invocationId });
        if (r.state !== 'completed') { yield { op: 'fail', error: `model invocation ended '${r.state}': ${r.error ?? ''}` }; return; }
        const out = (r.output ?? {}) as LlmOutput;
        if (out.toolCall !== undefined) {
          const tc = out.toolCall;
          yield { op: 'progress', note: `turn ${turn}: model requested tool ${tc.op}(${tc.a},${tc.b})` };
          const t = await ctx.kernel.invoke(calc.id, tc, { causationId: ctx.invocationId });
          if (t.state !== 'completed') { yield { op: 'fail', error: `tool invocation ended '${t.state}': ${t.error ?? ''}` }; return; }
          const value = (t.output as { value: number }).value;
          transcript += `\nTOOL-RESULT ${tc.op}(${tc.a},${tc.b}) = ${value}`;
          continue;
        }
        // no tool call -> terminate
        yield { op: 'artifact', content: { transcript, answer: out.text }, label: 'agent-transcript' };
        yield { op: 'result', output: { answer: out.text, turns: turn, childGrantId: child.id } };
        return;
      }
      yield { op: 'fail', error: 'coding-agent: turn budget (6) exhausted without termination' };
    },
  };
}
