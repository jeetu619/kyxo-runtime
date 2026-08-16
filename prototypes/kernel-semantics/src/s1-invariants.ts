/**
 * S1 invariants — properties that must hold of a family projection at every rest point.
 *
 * These are checked after every crash, every restart, every fork and every fuzz step. An
 * invariant that is only checked at the end of a happy path is decoration; the point of
 * this file is that a violation is loud wherever it first appears.
 *
 * They are deliberately written against the FOLD's output, not against kernel internals,
 * so the same checks apply to a projection the kernel built live and one an independent
 * reader rebuilt from the journal.
 */

import type { FamilyProjection, S1Event } from './s1-types.ts';
import { requiresExclusiveClaim } from './s1-types.ts';
import { digest, foldAll, protectionFor } from './s1-fold.ts';
import { canonical, sha } from './storage.ts';
import type { EffectKey } from './types.ts';

export class InvariantViolation extends Error {}

export interface CheckContext {
  /** The journal the projection is supposed to be derived from, if available. */
  readonly events?: readonly S1Event[] | undefined;
  /** True while invocations are in flight; relaxes the at-rest-only checks. */
  readonly inFlight?: boolean | undefined;
}

function fail(id: string, message: string): never {
  throw new InvariantViolation(`${id}: ${message}`);
}

/**
 * S1-I1  At most one claim per effect key, and an exclusive key never has two.
 * S1-I2  Every landing has a claim; the world cannot be touched without a lease.
 * S1-I3  Live state equals a fold of the journal (B4's whole content).
 * S1-I4  An exclusive effect key lands at most once in a family.
 * S1-I5  No grant is over-committed in any unit, and no ledger figure is negative.
 * S1-I6  A terminal invocation holds no reservation.
 * S1-I7  Every landed exclusive key is reported as protected.
 * S1-I8  Sequence numbers are dense and monotonic within each execution.
 * S1-I9  The hash chain links, and each self hash recomputes.
 * S1-I10 Every payload matches the hash the chain committed to, unless tombstoned.
 * S1-I11 A grant chain is acyclic.
 * S1-I12 Every invocation references a grant the family knows.
 */
export function assertS1Invariants(fam: FamilyProjection, ctx: CheckContext = {}): void {
  // ---- S1-I1 / S1-I2 / S1-I4: claims and landings -------------------------
  const landedByKey = new Map<string, number>();
  for (const l of fam.landed) {
    landedByKey.set(l.effectKey, (landedByKey.get(l.effectKey) ?? 0) + 1);
    if (!fam.claims.has(l.effectKey)) {
      fail('S1-I2', `effect ${l.effectKey} landed with no claim record — the world was touched without a lease`);
    }
    if (requiresExclusiveClaim(l.effectClass) && (landedByKey.get(l.effectKey) ?? 0) > 1) {
      fail('S1-I4', `exclusive effect ${l.effectKey} landed ${String(landedByKey.get(l.effectKey))} times`);
    }
  }

  for (const [key, claim] of fam.claims) {
    if (claim.effectKey !== key) fail('S1-I1', `claim table key ${key} disagrees with claim ${claim.effectKey}`);
    if (claim.exclusive !== requiresExclusiveClaim(claim.effectClass)) {
      fail('S1-I1', `claim ${key} exclusivity (${String(claim.exclusive)}) disagrees with its class ${claim.effectClass}`);
    }
  }

  // ---- S1-I7: protection covers every landed exclusive key ----------------
  for (const l of fam.landed) {
    if (!requiresExclusiveClaim(l.effectClass)) continue;
    if (!protectionFor(fam, l.effectKey).protected) {
      fail('S1-I7', `effect ${l.effectKey} landed but is not protected — a fork could repeat it`);
    }
  }

  // ---- S1-I5 / S1-I11: the grant ledger -----------------------------------
  for (const [id, g] of fam.grants) {
    if (g.id !== id) fail('S1-I5', `grant table key ${id} disagrees with grant ${g.id}`);
    for (const bucket of ['reserved', 'settled'] as const) {
      for (const [unit, amount] of Object.entries(g[bucket])) {
        if (amount < 0) fail('S1-I5', `grant ${id} has negative ${bucket} ${unit}: ${String(amount)}`);
      }
    }
    for (const [unit, limit] of Object.entries(g.limits)) {
      const committed = (g.reserved[unit] ?? 0) + (g.settled[unit] ?? 0);
      if (committed > limit) {
        fail('S1-I5', `grant ${id} over-committed ${unit}: ${String(committed)} > ${String(limit)}`);
      }
    }
    // S1-I11: walk to the root; a cycle would otherwise hang every ledger query.
    const seen = new Set<string>([id]);
    let cur = g.parent;
    while (cur !== undefined) {
      if (seen.has(cur)) fail('S1-I11', `grant chain from ${id} contains a cycle at ${cur}`);
      seen.add(cur);
      cur = fam.grants.get(cur)?.parent;
    }
  }

  // ---- S1-I6 / S1-I12: invocations ----------------------------------------
  for (const exec of fam.executions.values()) {
    for (const inv of exec.invocations.values()) {
      if (!fam.grants.has(inv.grantId)) {
        fail('S1-I12', `invocation ${inv.id} references unknown grant ${inv.grantId}`);
      }
      const terminal = inv.state === 'completed' || inv.state === 'failed' || inv.state === 'canceled';
      if (terminal && ctx.inFlight !== true) {
        // The invocation's own reservation must have been released back to the ledger.
        // Checked family-wide below rather than per-invocation, because reservations
        // aggregate; here we only assert nothing is still attributed to a finished lease.
        const g = fam.grants.get(inv.grantId)!;
        for (const [unit, held] of Object.entries(inv.reservation)) {
          if (held > 0 && (g.reserved[unit] ?? 0) > sumOutstanding(fam, unit)) {
            fail('S1-I6', `terminal invocation ${inv.id} still holds ${unit}`);
          }
        }
      }
    }
  }

  // ---- S1-I8 / S1-I9 / S1-I10 / S1-I3: the journal -------------------------
  if (ctx.events !== undefined) {
    const byExec = new Map<string, S1Event[]>();
    for (const ev of ctx.events) {
      const list = byExec.get(ev.executionId) ?? [];
      list.push(ev);
      byExec.set(ev.executionId, list);
    }

    for (const [execId, evs] of byExec) {
      let expected = 1;
      let prev = 'genesis';
      for (const ev of evs) {
        if (ev.seq !== expected) {
          fail('S1-I8', `execution ${execId} seq gap: expected ${String(expected)}, saw ${String(ev.seq)}`);
        }
        expected += 1;
        if (ev.integrity.prev !== prev) {
          fail('S1-I9', `execution ${execId} chain broken at seq ${String(ev.seq)}`);
        }
        const { payload: _omit, integrity, ...rest } = ev as S1Event & Record<string, unknown>;
        if (sha({ ...rest, prev: integrity.prev }) !== ev.integrity.self) {
          fail('S1-I9', `execution ${execId} self hash mismatch at seq ${String(ev.seq)}`);
        }
        const tombstoned = (ev.payload as { redacted?: boolean }).redacted === true;
        if (!tombstoned && sha(canonical(ev.payload)) !== ev.payloadHash) {
          fail('S1-I10', `execution ${execId} payload does not match its hash at seq ${String(ev.seq)}`);
        }
        prev = ev.integrity.self;
      }
    }

    // S1-I3 is the load-bearing one: everything above could pass while live state and
    // replayed state quietly disagree, which is precisely how F-6, F-8 and F-9 survived.
    const replayed = foldAll(fam.familyId, ctx.events);
    if (digest(replayed) !== digest(fam)) {
      fail('S1-I3', 'live state and replayed state disagree — there is a second reconstruction path');
    }
  }
}

/** Total reservation still outstanding across non-terminal invocations, for one unit. */
function sumOutstanding(fam: FamilyProjection, unit: string): number {
  let total = 0;
  for (const exec of fam.executions.values()) {
    for (const inv of exec.invocations.values()) {
      const terminal = inv.state === 'completed' || inv.state === 'failed' || inv.state === 'canceled';
      if (!terminal) total += inv.reservation[unit] ?? 0;
    }
  }
  return total;
}

/** Convenience for tests: check every family a kernel knows. */
export function assertAllFamilies(
  families: Iterable<FamilyProjection>,
  eventsFor: (fam: FamilyProjection) => readonly S1Event[],
  ctx: CheckContext = {},
): void {
  for (const fam of families) {
    assertS1Invariants(fam, { ...ctx, events: eventsFor(fam) });
  }
}

/** Every effect key that has landed. Useful for cross-checking a reference model. */
export function landedKeys(fam: FamilyProjection): EffectKey[] {
  return [...new Set(fam.landed.map((l) => l.effectKey))];
}
