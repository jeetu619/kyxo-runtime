/**
 * reactive.ts — ReactiveHarness: the classic agent loop as a behaviour.
 *
 * Strategy: act immediately. Every turn is either "ask the model with the
 * transcript so far" or "execute the tool call the model just requested".
 * No plan, no lookahead, no artifacts beyond what the driver journals.
 *
 * Termination: the model answered with NO tool call (the no-pending-tools
 * policy — one of the observed termination variants; supplied by the
 * behaviour, never hard-coded in the driver or the kernel).
 *
 * verify is intentionally ABSENT: the optional callback stays optional.
 */

import type {
  ActIntent, CompiledContext, ContinuationDecision, HarnessBehaviour, HarnessCtx,
  LoopSignals, Observation,
} from './behaviour.ts';

interface ToolCall { readonly op: string; readonly a: number; readonly b: number }
interface ModelOut { readonly text?: string; readonly toolCall?: ToolCall }

interface ReactiveState {
  readonly transcript: readonly string[];
  readonly pendingTool: ToolCall | undefined;
  readonly finalText: string | undefined;
}

export interface ReactiveConfig {
  /** Capability id of the model to bind. */
  readonly model: string;
  /** Scripted-session name — an opaque model parameter from the harness's view. */
  readonly session: string;
  /** Capability id of the tool to bind. */
  readonly tool: string;
}

export function makeReactiveHarness(cfg: ReactiveConfig): HarnessBehaviour<ReactiveState> {
  return {
    id: 'reactive-harness',
    version: '0.1.0',
    summary: 'model->tool loop; act immediately; terminate on no-tool-call',
    needs: [
      {
        alias: 'model', capabilityId: cfg.model, role: 'model', requirements: [
          { axis: 'toolDialect', need: 'one-of', anyOf: ['kyxo-json'] },
          { axis: 'session', need: 'one-of', anyOf: [cfg.session] },
          { axis: 'streaming', need: 'enabled' },
        ],
      },
      {
        alias: 'tool', capabilityId: cfg.tool, role: 'tool', requirements: [
          { axis: 'operations', need: 'present' },
        ],
      },
    ],

    init: (ctx: HarnessCtx): ReactiveState => ({
      transcript: [`OBJECTIVE: ${ctx.objective}`],
      pendingTool: undefined,
      finalText: undefined,
    }),

    compileContext: (_ctx, s): CompiledContext => {
      const prompt = s.transcript.join('\n');
      return {
        prompt,
        sources: s.transcript.length > 1 ? ['objective', 'tool-results'] : ['objective'],
        tokenEstimate: Math.ceil(prompt.length / 4),
      };
    },

    act: (_ctx, s, view): ActIntent =>
      s.pendingTool !== undefined
        ? {
          binding: 'tool',
          request: { op: s.pendingTool.op, a: s.pendingTool.a, b: s.pendingTool.b },
          note: `execute tool-call ${s.pendingTool.op}(${s.pendingTool.a},${s.pendingTool.b})`,
        }
        : {
          binding: 'model',
          request: { session: cfg.session, prompt: view.prompt },
          note: 'ask model (react to the latest transcript)',
        },

    integrateObservation: (_ctx, s, obs: Observation): ReactiveState => {
      if (obs.kind === 'model-reply') {
        const out = obs.output as ModelOut;
        if (out.toolCall !== undefined) return { ...s, pendingTool: out.toolCall };
        return { ...s, finalText: out.text ?? '(model returned neither text nor tool call)' };
      }
      if (obs.kind === 'tool-result') {
        const tc = s.pendingTool;
        const value = (obs.output as { value: number }).value;
        const line = tc !== undefined ? `TOOL-RESULT ${tc.op}(${tc.a},${tc.b}) = ${value}` : `TOOL-RESULT ? = ${value}`;
        return { ...s, pendingTool: undefined, transcript: [...s.transcript, line] };
      }
      // invocation-trouble: surface the error to the model on the next turn
      return { ...s, pendingTool: undefined, transcript: [...s.transcript, `TOOL-ERROR ${obs.error}`] };
    },

    decideContinuation: (_ctx, s, signals: LoopSignals): ContinuationDecision => {
      if (s.finalText !== undefined) {
        return { kind: 'finalize', output: { answer: s.finalText, transcript: s.transcript } };
      }
      if (signals.failureStreak >= 2) {
        return { kind: 'fail', error: `reactive: ${signals.failureStreak} consecutive failed invocations` };
      }
      return { kind: 'continue' };
    },
  };
}
