/**
 * local-model.ts — an OpenAI-compat-dialect local model mock: different tool
 * dialect, chat-completions request shape, and NO reasoning axis at all.
 * Negotiation must still bind it where requirements allow, and must REJECT
 * (loudly, at bind time) any binding requiring reasoning >= trace — the
 * missing-axis-never-silently-degrades rule, demonstrated in the demo.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface ChatMessage { readonly role: string; readonly content: string }
interface ChatRequest { readonly messages?: readonly ChatMessage[]; readonly temperature?: number }

const reply = (last: string): string =>
  last.trim() === 'ping' ? 'pong' : `local-model says: ${last.slice(0, 40).split('').reverse().join('')}`;

export const localModel: CapabilityProvider = {
  identity: { id: 'local-model', version: '0.9.0', stability: 'testing' },
  manifest: {
    identity: { id: 'local-model', version: '0.9.0', stability: 'testing' },
    summary: 'Local OpenAI-compat chat model: openai-tools dialect, no reasoning axis.',
    axes: {
      // deliberately NO 'reasoning' axis — this model exposes none
      toolDialect: { shape: 'options', offered: ['openai-tools'] },
      streaming: { shape: 'flag', enabled: true },
      sampling: { shape: 'options', offered: ['temperature', 'top_p'] },
      structuredOutput: { shape: 'tiered', tier: 'json', ladder: ['none', 'json'] },
    },
    experimental: { grammarConstraints: 'gbnf' },
    extensions: { 'com.openai.compat': { endpoint: '/v1/chat/completions', servedBy: 'llama.cpp (mock)' } },
  },

  async *invoke(request: unknown, _ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as ChatRequest;
    const last = req.messages?.at(-1)?.content ?? '';
    const content = reply(last);
    yield { op: 'progress', note: 'sse-chunk', data: content.slice(0, Math.ceil(content.length / 2)) };
    yield { op: 'progress', note: 'sse-chunk', data: content.slice(Math.ceil(content.length / 2)) };
    const usage = { prompt_tokens: Math.ceil(last.length / 4) + 8, completion_tokens: Math.ceil(content.length / 4) };
    yield { op: 'charge', cost: { tokens: usage.prompt_tokens + usage.completion_tokens }, note: 'local inference (no money cost)' };
    yield {
      op: 'result',
      output: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage },
    };
  },

  async probe(ctx) {
    return { capabilityId: 'local-model', ok: true, evidence: { probedAt: ctx.clock(), dialect: 'openai-tools', reasoningAxis: 'absent (by design)' } };
  },
};
