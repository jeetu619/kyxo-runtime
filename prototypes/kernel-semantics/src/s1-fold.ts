/**
 * THE fold (B4).
 *
 * This is the only code in the system that turns committed records into derived state.
 * Live execution, recovery, resume, checkpoint and fork all read state produced here —
 * there is no second reconstruction path, which is what made F-6, F-8 and F-9 possible.
 *
 * Property S1-I3: for every committed prefix, live state == fold(prefix, empty).
 * Asserted continuously by the property suite, not just at recovery.
 */

import {
  type ClaimRecord, type ClaimState, type ExecutionProjection, type FamilyId,
  type FamilyProjection, type GrantLedgerEntry, type LineageNode, type S1Event, type Units,
  emptyFamily, requiresExclusiveClaim,
} from './s1-types.ts';
import type { EffectClass, EffectKey, ExecutionId, GrantId, InvocationId, InvocationState } from './types.ts';
import { canonical } from './storage.ts';

function emptyExecution(id: ExecutionId, familyId: FamilyId): ExecutionProjection {
  return {
    executionId: id,
    familyId,
    correlationId: id,
    seq: 0,
    lastHash: 'genesis',
    definitionHash: 'D1',
    invocations: new Map(),
    cell: new Map(),
    artifacts: [],
    evidence: new Map(),
    cancelRequested: new Set(),
  };
}

function addUnits(a: Units, b: Units, sign: 1 | -1): Units {
  const out: Record<string, number> = { ...a };
  for (const [unit, amount] of Object.entries(b)) {
    out[unit] = Math.max(0, (out[unit] ?? 0) + sign * amount);
  }
  return out;
}

/** Fold a single committed event into the family projection. Pure and total. */
export function foldEvent(fam: FamilyProjection, ev: S1Event): void {
  const p = ev.payload as Record<string, unknown>;

  // Every event advances its execution's cursor; unknown kinds still do this, which is
  // what makes forward compatibility safe (an unknown kind must not break the chain).
  let exec = fam.executions.get(ev.executionId);
  if (exec === undefined) {
    exec = emptyExecution(ev.executionId, ev.familyId);
    fam.executions.set(ev.executionId, exec);
  }
  exec.seq = ev.seq;
  exec.lastHash = ev.integrity.self;
  exec.correlationId = ev.correlationId;

  switch (ev.kind) {
    case 'execution.created':
      exec.definitionHash = (p['definitionHash'] as string) ?? exec.definitionHash;
      fam.lineage.set(ev.executionId, { executionId: ev.executionId, familyId: ev.familyId });
      break;

    case 'execution.forked': {
      const parent = p['parentExecution'] as ExecutionId;
      const cutSeq = p['cutSeq'] as number;
      exec.definitionHash = (p['definitionHash'] as string) ?? exec.definitionHash;
      exec.parent = { executionId: parent, cutSeq };
      fam.lineage.set(ev.executionId, {
        executionId: ev.executionId,
        familyId: ev.familyId,
        parent: { executionId: parent, cutSeq },
      });
      // Cell state at the cut is carried in the fork record itself, so the child's
      // journal is self-sufficient (F-8). No checkpoint blob is consulted here.
      for (const [k, v] of (p['inheritedCell'] as [string, unknown][] | undefined) ?? []) {
        exec.cell.set(k, v);
      }
      for (const ref of (p['inheritedArtifacts'] as string[] | undefined) ?? []) {
        exec.artifacts.push(ref as never);
      }
      break;
    }

    // ---- Effect claims (B1) --------------------------------------------------
    case 'effect.claimed': {
      const claim: ClaimRecord = {
        claimId: p['claimId'] as never,
        effectKey: p['effectKey'] as EffectKey,
        effectClass: p['effectClass'] as EffectClass,
        exclusive: p['exclusive'] === true,
        holder: ev.invocationId!,
        executionId: ev.executionId,
        familyId: ev.familyId,
        seq: ev.seq,
        state: 'held',
      };
      fam.claims.set(claim.effectKey, claim);
      break;
    }

    case 'effect.landed': {
      const key = p['effectKey'] as EffectKey;
      fam.landed.push({
        effectKey: key,
        effectClass: p['effectClass'] as EffectClass,
        executionId: ev.executionId,
        seq: ev.seq,
        descriptor: (p['descriptor'] as string) ?? '',
      });
      const c = fam.claims.get(key);
      if (c !== undefined) fam.claims.set(key, { ...c, state: 'landed' });
      break;
    }

    case 'effect.released': {
      const key = p['effectKey'] as EffectKey;
      const c = fam.claims.get(key);
      // A released claim frees the key ONLY if nothing landed under it.
      if (c !== undefined && c.state !== 'landed' && c.state !== 'settled') {
        fam.claims.delete(key);
      } else if (c !== undefined) {
        fam.claims.set(key, { ...c, state: 'settled' });
      }
      break;
    }

    case 'effect.settled': {
      const key = p['effectKey'] as EffectKey;
      const c = fam.claims.get(key);
      if (c !== undefined) {
        const next = (p['state'] as ClaimState | undefined) ?? 'settled';
        fam.claims.set(key, { ...c, state: next });
      }
      break;
    }

    // ---- Invocation lifecycle ------------------------------------------------
    case 'invocation.admitted':
      exec.invocations.set(ev.invocationId!, {
        id: ev.invocationId!,
        capabilityId: p['capabilityId'] as string,
        effectKey: p['effectKey'] as EffectKey,
        effectClass: p['effectClass'] as EffectClass,
        grantId: ev.grantId!,
        state: 'admitted',
        requiresEvidence: p['requiresEvidence'] === true,
      });
      break;

    case 'invocation.dispatched':
      patch(exec, ev.invocationId!, { state: 'dispatched' });
      break;

    case 'invocation.completed': {
      patch(exec, ev.invocationId!, { state: 'completed' });
      const key = p['effectKey'] as EffectKey | undefined;
      if (key !== undefined) {
        fam.outcomes.set(key, { invocationId: ev.invocationId!, state: 'completed', output: p['output'] });
      }
      break;
    }

    case 'invocation.failed': {
      patch(exec, ev.invocationId!, { state: 'failed' });
      const key = p['effectKey'] as EffectKey | undefined;
      // A failure does NOT occupy the key permanently unless the effect landed:
      // transient failure must remain retryable (review #2 finding 17/38).
      if (key !== undefined && p['landedExternal'] === true) {
        fam.outcomes.set(key, { invocationId: ev.invocationId!, state: 'failed' });
      }
      break;
    }

    case 'invocation.canceled':
      patch(exec, ev.invocationId!, { state: 'canceled' });
      break;

    case 'invocation.suspended':
      patch(exec, ev.invocationId!, {
        state: 'suspended',
        suspension: { reason: p['reason'] as string, payload: p['payload'] },
      });
      break;

    case 'invocation.resumed':
      patch(exec, ev.invocationId!, { state: 'dispatched' });
      break;

    case 'invocation.uncertain': {
      patch(exec, ev.invocationId!, { state: 'uncertain' });
      const key = p['effectKey'] as EffectKey | undefined;
      if (key !== undefined) {
        const c = fam.claims.get(key);
        if (c !== undefined) fam.claims.set(key, { ...c, state: 'uncertain' });
      }
      break;
    }

    case 'invocation.uncertainty.resolved': {
      const resolved = p['resolved'] as InvocationState;
      patch(exec, ev.invocationId!, { state: resolved });
      const key = p['effectKey'] as EffectKey | undefined;
      if (key !== undefined) {
        const c = fam.claims.get(key);
        if (c !== undefined) {
          const next: ClaimState = resolved === 'completed' ? 'settled'
            : p['landed'] === true ? 'settled'
            : resolved === 'uncertain' ? 'uncertain' : 'released';
          if (next === 'released') fam.claims.delete(key);
          else fam.claims.set(key, { ...c, state: next });
        }
        if (p['landed'] === true) {
          fam.landed.push({
            effectKey: key,
            effectClass: (p['effectClass'] as EffectClass) ?? 'external-irreversible',
            executionId: ev.executionId,
            seq: ev.seq,
            descriptor: 'resolved-landed',
          });
        }
      }
      break;
    }

    case 'invocation.cancel.requested':
      exec.cancelRequested.add(ev.invocationId!);
      break;

    // ---- Effects on kernel-owned state ---------------------------------------
    case 'state.updated':
      exec.cell.set(p['key'] as string, p['value']);
      break;

    case 'artifact.produced':
      exec.artifacts.push(p['ref'] as never);
      break;

    case 'evidence.produced':
      exec.evidence.set(ev.invocationId!, p['verdict'] as 'pass' | 'fail');
      break;

    // ---- Family-scoped grant ledger (B2, B9b) --------------------------------
    case 'grant.issued':
    case 'grant.attenuated': {
      const id = ev.grantId!;
      if (!fam.grants.has(id)) {
        fam.grants.set(id, {
          id,
          parent: p['parent'] as GrantId | undefined,
          familyId: ev.familyId,
          rights: (p['rights'] as string[]) ?? [],
          limits: (p['limits'] as Units) ?? {},
          reserved: {},
          settled: {},
          revoked: false,
          expiresAt: p['expiresAt'] as number | undefined,
        });
      }
      break;
    }

    case 'grant.reserved':
      moveLedger(fam, ev.grantId!, p['units'] as Units, 'reserved', +1);
      break;

    case 'grant.settled':
      moveLedger(fam, ev.grantId!, (p['releasing'] as Units) ?? {}, 'reserved', -1);
      moveLedger(fam, ev.grantId!, p['units'] as Units, 'settled', +1);
      break;

    case 'grant.released':
      moveLedger(fam, ev.grantId!, p['units'] as Units, 'reserved', -1);
      break;

    case 'grant.revoked': {
      const g = fam.grants.get(ev.grantId!);
      if (g !== undefined) fam.grants.set(g.id, { ...g, revoked: true });
      break;
    }

    default:
      // Unknown kinds are retained and advance the cursor without changing semantics.
      break;
  }
}

function patch(
  exec: ExecutionProjection,
  id: InvocationId,
  delta: Partial<{ state: InvocationState; suspension: { reason: string; payload: unknown } | undefined }>,
): void {
  const cur = exec.invocations.get(id);
  if (cur !== undefined) exec.invocations.set(id, { ...cur, ...delta });
}

/** Ledger movement applies to the whole grant chain, family-wide. */
function moveLedger(fam: FamilyProjection, grantId: GrantId, units: Units, bucket: 'reserved' | 'settled', sign: 1 | -1): void {
  let cur: GrantId | undefined = grantId;
  const seen = new Set<GrantId>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const g: GrantLedgerEntry | undefined = fam.grants.get(cur);
    if (g === undefined) break;
    fam.grants.set(g.id, { ...g, [bucket]: addUnits(g[bucket], units ?? {}, sign) } as GrantLedgerEntry);
    cur = g.parent;
  }
}

/** Rebuild a family from committed records only. The one recovery path. */
export function foldAll(familyId: FamilyId, events: readonly S1Event[]): FamilyProjection {
  const fam = emptyFamily(familyId);
  for (const ev of events) foldEvent(fam, ev);
  return fam;
}

/**
 * Canonical, order-independent serialization of everything the fold derives.
 *
 * B4 claims there is one authoritative fold, which is only meaningful if "live state
 * equals replayed state" can be CHECKED rather than asserted. This is that check's
 * subject: digest(live) must equal digest(fold(journal)) at every committed prefix
 * (property S1-I3). Anything a fold derives but this omits is state that could silently
 * diverge, so omissions here are load-bearing — every field of FamilyProjection appears.
 */
export function digest(fam: FamilyProjection): string {
  const sortEntries = <V,>(m: Map<string, V>): [string, V][] =>
    [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const executions = sortEntries(fam.executions as Map<string, ExecutionProjection>).map(([id, e]) => [
    id,
    {
      familyId: e.familyId, correlationId: e.correlationId, seq: e.seq,
      lastHash: e.lastHash, definitionHash: e.definitionHash, parent: e.parent ?? null,
      invocations: sortEntries(e.invocations as Map<string, unknown>),
      cell: sortEntries(e.cell as Map<string, unknown>),
      artifacts: [...e.artifacts].sort(),
      evidence: sortEntries(e.evidence as Map<string, unknown>),
      cancelRequested: [...e.cancelRequested].sort(),
    },
  ]);

  return canonical({
    familyId: fam.familyId,
    executions,
    lineage: sortEntries(fam.lineage as Map<string, unknown>),
    claims: sortEntries(fam.claims as Map<string, unknown>),
    // Landed effects are an append-only log; order is part of the truth, so it is NOT
    // sorted away — two folds that disagree on ordering must be caught, not smoothed.
    landed: fam.landed,
    grants: sortEntries(fam.grants as Map<string, unknown>),
    outcomes: sortEntries(fam.outcomes as Map<string, unknown>),
  });
}

// ---------------------------------------------------------------------------
// Ancestor-scoped protection (B9a) — a query over folded state, not a second store
// ---------------------------------------------------------------------------

/**
 * Is `effectKey` protected for `executionId`?
 *
 * An execution is bound by effects landed in its own lineage: its own, plus any landed
 * in an ancestor at or before the sequence at which this lineage branched away.
 *
 * It is NOT bound by a sibling's effects. Siblings are divergent world-lines, and
 * treating A's charge as B's would be as wrong as missing a replay.
 */
export function protectionFor(
  fam: FamilyProjection,
  executionId: ExecutionId,
  effectKey: EffectKey,
): { protected: boolean; by?: { executionId: ExecutionId; seq: number } } {
  // Walk this execution's ancestry, carrying the visibility horizon of each ancestor.
  let cursor: ExecutionId | undefined = executionId;
  let horizon = Number.POSITIVE_INFINITY;
  const guard = new Set<ExecutionId>();

  while (cursor !== undefined && !guard.has(cursor)) {
    guard.add(cursor);
    for (const l of fam.landed) {
      if (l.effectKey !== effectKey) continue;
      if (l.executionId !== cursor) continue;
      if (l.seq <= horizon) return { protected: true, by: { executionId: l.executionId, seq: l.seq } };
    }
    const node: LineageNode | undefined = fam.lineage.get(cursor);
    if (node?.parent === undefined) break;
    horizon = node.parent.cutSeq;
    cursor = node.parent.executionId;
  }
  return { protected: false };
}

/** Remaining capacity for a unit, family-wide, across the whole grant chain. */
export function remaining(fam: FamilyProjection, grantId: GrantId, unit: string): number {
  let min = Number.POSITIVE_INFINITY;
  let cur: GrantId | undefined = grantId;
  const seen = new Set<GrantId>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const g: GrantLedgerEntry | undefined = fam.grants.get(cur);
    if (g === undefined) break;
    const limit = g.limits[unit];
    if (limit !== undefined) {
      min = Math.min(min, limit - (g.reserved[unit] ?? 0) - (g.settled[unit] ?? 0));
    }
    cur = g.parent;
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}

/** Any revoked or expired grant in the chain denies the whole chain. */
export function chainBlocked(fam: FamilyProjection, grantId: GrantId, now: number): string | null {
  let cur: GrantId | undefined = grantId;
  const seen = new Set<GrantId>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const g: GrantLedgerEntry | undefined = fam.grants.get(cur);
    if (g === undefined) return 'unknown-grant';
    if (g.revoked) return 'revoked';
    if (g.expiresAt !== undefined && now > g.expiresAt) return 'expired';
    cur = g.parent;
  }
  return null;
}

export { requiresExclusiveClaim };
