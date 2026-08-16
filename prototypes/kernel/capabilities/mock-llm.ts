/**
 * mock-llm.ts — a raw LLM capability with deterministic scripted responses.
 * CHEAT: the "model" is an ordered rule table keyed on prompt substrings,
 * scripted to the demo's objectives. Token accounting is chars/4.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface LlmRequest { readonly prompt?: string; readonly tools?: readonly string[] }
interface ToolCall { readonly op: string; readonly a: number; readonly b: number }
interface LlmReply { readonly text?: string; readonly toolCall?: ToolCall }

/** Ordered, first-match-wins script. Later turns match earlier rules. */
const SCRIPT: ReadonlyArray<{ when: (p: string) => boolean; reply: (p: string) => LlmReply }> = [
  { when: (p) => p.includes('TOOL-RESULT mul(5,7) = 35'), reply: () => ({ text: 'Done: (2+3)*7 = 35.' }) },
  { when: (p) => p.includes('TOOL-RESULT add(2,3) = 5'), reply: () => ({ toolCall: { op: 'mul', a: 5, b: 7 } }) },
  { when: (p) => p.includes('OBJECTIVE: add 2 and 3'), reply: () => ({ toolCall: { op: 'add', a: 2, b: 3 } }) },
  {
    when: (p) => p.toLowerCase().includes('haiku'),
    reply: () => ({ text: 'journal holds the truth /\nnine small objects, one contract /\ncapabilities bloom' }),
  },
  { when: () => true, reply: (p) => ({ text: `scripted-echo: ${p.slice(0, 48)}` }) },
];

const tokensFor = (s: string): number => Math.ceil(s.length / 4);

export const mockLlm: CapabilityProvider = {
  identity: { id: 'mock-llm', version: '1.0.0', stability: 'stable' },
  manifest: {
    identity: { id: 'mock-llm', version: '1.0.0', stability: 'stable' },
    summary: 'Deterministic scripted chat model with visible reasoning traces.',
    axes: {
      reasoning: { shape: 'tiered', tier: 'trace', ladder: ['none', 'summary', 'trace'] },
      toolDialect: { shape: 'options', offered: ['kyxo-json'] },
      streaming: { shape: 'flag', enabled: true },
      structuredOutput: { shape: 'tiered', tier: 'json', ladder: ['none', 'json', 'json-schema'] },
    },
    experimental: { speculativeDecoding: false },
    extensions: { 'dev.kyxo.mock': { scripted: true, rules: SCRIPT.length } },
  },

  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as LlmRequest;
    const prompt = req.prompt ?? '';
    const rule = SCRIPT.find((r) => r.when(prompt));
    const reply = rule ? rule.reply(prompt) : { text: '(no rule matched)' };
    const rendered = JSON.stringify(reply);
    // negotiated streaming: emit the reply in two chunks before the commit
    yield { op: 'progress', note: 'stream-chunk', data: rendered.slice(0, Math.ceil(rendered.length / 2)) };
    yield { op: 'progress', note: 'stream-chunk', data: rendered.slice(Math.ceil(rendered.length / 2)) };
    yield { op: 'charge', cost: { tokens: tokensFor(prompt) + tokensFor(rendered) + 16, moneyCents: 1 }, note: 'prompt+completion tokens' };
    yield { op: 'result', output: { ...reply, usage: { promptTokens: tokensFor(prompt), completionTokens: tokensFor(rendered) + 16 } } };
  },

  async probe(ctx) {
    return {
      capabilityId: 'mock-llm', ok: true,
      evidence: { probedAt: ctx.clock(), scriptRules: SCRIPT.length, deterministic: true },
    };
  },
};
