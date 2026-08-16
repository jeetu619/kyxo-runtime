/**
 * Executable kernel invariants (docs/18-KERNEL-INVARIANTS.md).
 *
 * Every invariant here is checked after EVERY operation in the property suite, not
 * just at the end of a scenario. A violation is a design falsification, not a bug to
 * paper over.
 */

import type { KernelEvent, EffectKey } from './types.ts';
import { Kernel } from './kernel.ts';
import { Storage, sha } from './storage.ts';

export interface Violation {
  readonly id: string;
  readonly detail: string;
}

export interface InvariantContext {
  readonly kernel: Kernel;
  readonly storage: Storage;
  /** Journal snapshot taken before the operation, for immutability checks. */
  readonly priorJournal?: readonly KernelEvent[] | undefined;
  readonly priorByExecution?: ReadonlyMap<string, readonly KernelEvent[]> | undefined;
}

function allEvents(storage: Storage): KernelEvent[] {
  const out: KernelEvent[] = [];
  for (const rec of storage.readJournal().records) {
    const r = rec as { events: KernelEvent[] };
    out.push(...r.events);
  }
  return out;
}

export function checkInvariants(ctx: InvariantContext): Violation[] {
  const v: Violation[] = [];
  const { kernel, storage } = ctx;
  const events = allEvents(storage);
  const byExec = new Map<string, KernelEvent[]>();
  for (const e of events) {
    const list = byExec.get(e.executionId) ?? [];
    list.push(e);
    byExec.set(e.executionId, list);
  }

  // ---- I6: committed history is immutable and hash-chained ----
  for (const [execId, list] of byExec) {
    let prev = 'genesis';
    for (const e of list) {
      const { integrity, ...base } = e;
      if (integrity.prev !== prev) {
        v.push({ id: 'I6', detail: `chain break in ${execId} at seq ${e.seq}: prev=${integrity.prev} expected=${prev}` });
        break;
      }
      const expect = sha({ ...base, prev });
      if (integrity.self !== expect) {
        v.push({ id: 'I6', detail: `tampered event ${e.id} in ${execId} at seq ${e.seq}` });
        break;
      }
      prev = integrity.self;
    }
  }

  // ---- I6b: seq is dense and strictly monotonic per execution ----
  for (const [execId, list] of byExec) {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i]!.seq !== i + 1) {
        v.push({ id: 'I6b', detail: `seq gap in ${execId}: position ${i} has seq ${list[i]!.seq}` });
        break;
      }
    }
  }

  // ---- I7: every committed event carries causal lineage ----
  for (const e of events) {
    if (!e.executionId || !e.correlationId) {
      v.push({ id: 'I7', detail: `event ${e.id} (${e.kind}) lacks lineage identifiers` });
    }
    if (e.actorId !== 'kernel' && e.actorId.length === 0) {
      v.push({ id: 'I7', detail: `event ${e.id} has an empty actor` });
    }
  }

  // ---- I8: every artifact has provenance ----
  for (const e of events) {
    if (e.kind !== 'artifact.produced') continue;
    const producedBy = (e.payload as Record<string, unknown>)['producedBy'];
    const ref = (e.payload as Record<string, unknown>)['ref'] as string | undefined;
    if (typeof producedBy !== 'string' || producedBy.length === 0) {
      v.push({ id: 'I8', detail: `artifact event ${e.id} lacks producedBy` });
    }
    if (ref === undefined || !storage.hasBlob(ref)) {
      v.push({ id: 'I8', detail: `artifact ${String(ref)} referenced but absent from CAS` });
    }
  }

  // ---- I14: dedup/duplicate delivery must leave audit evidence ----
  // (Structural counterpart: every dedup path in the kernel commits a record. Here we
  // verify no execution has a completed invocation whose effect key appears twice with
  // no dedup record between them.)
  for (const [execId, list] of byExec) {
    const completedKeys = new Map<EffectKey, number>();
    for (const e of list) {
      const key = (e.payload as Record<string, unknown>)['effectKey'] as EffectKey | undefined;
      if (key === undefined) continue;
      if (e.kind === 'invocation.completed') {
        const seen = completedKeys.get(key);
        if (seen !== undefined) {
          const between = list.filter(
            (x) => x.seq > seen && x.seq < e.seq &&
              (x.kind === 'effect.deduplicated' || x.kind === 'delivery.duplicate' ||
               x.kind === 'execution.forked' || x.kind === 'invocation.uncertainty.resolved'),
          );
          if (between.length === 0) {
            v.push({ id: 'I13', detail: `effect ${key} completed twice in ${execId} with no dedup/fork/resolution record` });
          }
        }
        completedKeys.set(key, e.seq);
      }
    }
  }

  // ---- I15: uncertainty is explicit, never guessed ----
  for (const [, list] of byExec) {
    const dispatched = new Map<string, KernelEvent>();
    for (const e of list) {
      if (e.kind === 'invocation.dispatched') dispatched.set(e.invocationId!, e);
      if (e.kind === 'invocation.completed' || e.kind === 'invocation.failed' ||
          e.kind === 'invocation.canceled' || e.kind === 'invocation.uncertain' ||
          e.kind === 'invocation.suspended') {
        dispatched.delete(e.invocationId!);
      }
    }
    // Anything still dispatched at the tip is in-flight; the kernel must not have
    // silently concluded anything about it. (Presence here is fine; a *completed*
    // record without a dispatch is not — checked below.)
  }
  for (const [execId, list] of byExec) {
    const seenDispatch = new Set<string>();
    for (const e of list) {
      if (e.kind === 'invocation.dispatched') seenDispatch.add(e.invocationId!);
      if (e.kind === 'invocation.completed' && e.payload['resolvedFromUncertainty'] !== true) {
        if (!seenDispatch.has(e.invocationId!)) {
          v.push({ id: 'I15', detail: `${execId}: invocation ${e.invocationId} completed without a dispatch record` });
        }
      }
    }
  }

  // ---- I17: a failed verification cannot present as success ----
  for (const [execId, list] of byExec) {
    const failedEvidence = new Set<string>();
    for (const e of list) {
      if (e.kind === 'evidence.produced' && e.payload['verdict'] === 'fail') failedEvidence.add(e.invocationId!);
      if (e.kind === 'invocation.completed' && failedEvidence.has(e.invocationId!)) {
        // Only a violation when the invocation required evidence; the admitted record says so.
        const admitted = list.find((x) => x.kind === 'invocation.admitted' && x.invocationId === e.invocationId);
        if (admitted?.payload['requiresEvidence'] === true) {
          v.push({ id: 'I17', detail: `${execId}: ${e.invocationId} completed despite failing evidence under a commit gate` });
        }
      }
    }
  }

  // ---- I5 / I18: grants never widen; budgets never go negative ----
  for (const execId of kernel.executionIds()) {
    const st = kernel.state(execId as never);
    for (const g of st.grants.values()) {
      for (const [unit, limit] of Object.entries(g.limits)) {
        const used = (g.reserved[unit] ?? 0) + (g.settled[unit] ?? 0);
        if (used > limit) {
          v.push({ id: 'I5', detail: `${execId}: grant ${g.id} overspent ${unit}: ${used} > ${limit}` });
        }
      }
      for (const bucket of ['reserved', 'settled'] as const) {
        for (const [unit, amount] of Object.entries(g[bucket])) {
          if (amount < 0) v.push({ id: 'I5b', detail: `${execId}: grant ${g.id} negative ${bucket}.${unit}` });
        }
      }
      if (g.parent !== undefined) {
        const parent = st.grants.get(g.parent);
        if (parent !== undefined) {
          for (const r of g.rights) {
            if (!parent.rights.includes(r)) {
              v.push({ id: 'I18', detail: `${execId}: grant ${g.id} holds right '${r}' its parent ${parent.id} lacks` });
            }
          }
          for (const [unit, limit] of Object.entries(g.limits)) {
            const parentLimit = parent.limits[unit] ?? 0;
            if (limit > parentLimit) {
              v.push({ id: 'I18', detail: `${execId}: grant ${g.id} ${unit} limit ${limit} exceeds parent ${parentLimit}` });
            }
          }
        }
      }
    }
  }

  // ---- I11 / I10: prior committed history is never rewritten ----
  if (ctx.priorByExecution !== undefined) {
    for (const [execId, before] of ctx.priorByExecution) {
      const after = byExec.get(execId) ?? [];
      if (after.length < before.length) {
        v.push({ id: 'I10', detail: `${execId}: committed history shrank (${before.length} → ${after.length})` });
        continue;
      }
      for (let i = 0; i < before.length; i += 1) {
        const b = before[i]!;
        const a = after[i]!;
        if (b.id !== a.id || b.integrity.self !== a.integrity.self) {
          v.push({ id: 'I10', detail: `${execId}: committed event at position ${i} was rewritten` });
          break;
        }
      }
    }
  }

  // ---- I12: a fork declares explicit new lineage ----
  for (const [execId, list] of byExec) {
    const first = list[0];
    if (first === undefined) continue;
    if (first.kind === 'execution.forked') {
      const p = first.payload as Record<string, unknown>;
      if (typeof p['parentExecution'] !== 'string' || typeof p['cutSeq'] !== 'number') {
        v.push({ id: 'I12', detail: `${execId}: fork event lacks explicit parent lineage` });
      }
    } else if (first.kind !== 'execution.created') {
      v.push({ id: 'I12', detail: `${execId}: first event is ${first.kind}, not a lineage origin` });
    }
  }

  // ---- I16: no staged candidate survives as committed ----
  if (kernel.stagedCount() > 0) {
    v.push({ id: 'I16', detail: `${kernel.stagedCount()} staged proposal set(s) leaked past settlement` });
  }

  // ---- I9: checkpoints reference a valid committed boundary ----
  for (const e of events) {
    if (e.kind !== 'checkpoint.cut') continue;
    const cutSeq = (e.payload as Record<string, unknown>)['cutSeq'] as number;
    if (cutSeq >= e.seq) {
      v.push({ id: 'I9', detail: `checkpoint at ${e.id} claims cut ${cutSeq} ≥ its own seq ${e.seq}` });
    }
  }

  return v;
}

/** Assert helper for tests: throws with all violations if any invariant fails. */
export function assertInvariants(ctx: InvariantContext, label: string): void {
  const v = checkInvariants(ctx);
  if (v.length > 0) {
    throw new Error(`invariant violation(s) after ${label}:\n` + v.map((x) => `  [${x.id}] ${x.detail}`).join('\n'));
  }
}

export function snapshotByExecution(storage: Storage): Map<string, KernelEvent[]> {
  const m = new Map<string, KernelEvent[]>();
  for (const e of allEvents(storage)) {
    const l = m.get(e.executionId) ?? [];
    l.push(e);
    m.set(e.executionId, l);
  }
  return m;
}
