/**
 * mock-mcp-server.ts — an MCP-shaped adapter projected onto the capability
 * contract. Internally it speaks tools/list + tools/call semantics (the MCP
 * grammar); externally it is just another provider with an honest manifest.
 * CHEAT: no wire protocol, no process boundary — the "server" is in-process.
 */
import type { CapabilityEvent, CapabilityProvider, InvokeCtx } from '../types.ts';

interface McpRequest { readonly method?: string; readonly name?: string; readonly arguments?: Record<string, unknown> }

interface McpTool {
  readonly description: string;
  readonly inputSchema: Record<string, string>;
  readonly call: (args: Record<string, unknown>, ctx: InvokeCtx) => unknown;
}

const TOOLS: Readonly<Record<string, McpTool>> = {
  echo: {
    description: 'Echo the given text back.',
    inputSchema: { text: 'string' },
    call: (args) => ({ echoed: String(args['text'] ?? '') }),
  },
  'clock.now': {
    description: 'Current time from the kernel-injected clock (deterministic in the demo).',
    inputSchema: {},
    call: (_args, ctx) => ({ now: ctx.clock() }),
  },
};

export const mockMcpServer: CapabilityProvider = {
  identity: { id: 'mock-mcp', version: '0.3.0', stability: 'testing' },
  manifest: {
    identity: { id: 'mock-mcp', version: '0.3.0', stability: 'testing' },
    summary: 'MCP-shaped tool server (tools/list + tools/call) behind the contract.',
    axes: {
      toolDialect: { shape: 'options', offered: ['mcp'] },
      transport: { shape: 'options', offered: ['stdio', 'in-process'] },
      statefulness: { shape: 'tiered', tier: 'stateless', ladder: ['stateless', 'session'] },
      errorSemantics: { shape: 'options', offered: ['jsonrpc'] },
    },
    experimental: { listChanged: false },
    extensions: { 'io.modelcontextprotocol.server': { protocolRevision: '2025-06-18' } },
  },

  async *invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent> {
    const req = (request ?? {}) as McpRequest;
    if (req.method === 'tools/list') {
      const tools = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
      yield { op: 'result', output: { tools } };
      return;
    }
    if (req.method === 'tools/call') {
      const tool = TOOLS[req.name ?? ''];
      if (!tool) {
        yield { op: 'fail', error: `mcp: unknown tool '${String(req.name)}' (jsonrpc -32602)` };
        return;
      }
      yield { op: 'progress', note: `tools/call ${req.name}` };
      const content = tool.call(req.arguments ?? {}, ctx);
      // tool output crosses a trust boundary: label it so taint propagates
      yield { op: 'artifact', content, taint: ['mcp:external'], label: `mcp:${req.name}` };
      yield { op: 'result', output: { content, isError: false } };
      return;
    }
    yield { op: 'fail', error: `mcp: unsupported method '${String(req.method)}' (jsonrpc -32601)` };
  },

  async probe(ctx) {
    return { capabilityId: 'mock-mcp', ok: true, evidence: { probedAt: ctx.clock(), tools: Object.keys(TOOLS) } };
  },
};
