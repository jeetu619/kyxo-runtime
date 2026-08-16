/**
 * Deterministic reference model.
 *
 * A deliberately naive state machine expressing the INTENDED semantics with no
 * knowledge of the kernel's implementation (no journal, no hash chain, no staging).
 * Differential testing against this model exposes semantics that only exist by
 * accident of implementation.
 *
 * The model tracks only what the specification says is observable:
 *   - invocation states
 *   - cell state
 *   - grant budgets (reserve/settle)
 *   - which effect keys are known-executed in THIS lineage
 *   - which irreversible effects are protected
 */

import type { EffectClass, EffectKey, InvocationState } from '../src/types.ts';

export interface ModelGrant {
  id: string;
  parent?: string | undefined;
  rights: string[];
  limits: Record<string, number>;
  reserved: Record<string, number>;
  settled: Record<string, number>;
  revoked: boolean;
}

export interface ModelExecution {
  id: string;
  parent?: { id: string; cutSeq: number } | undefined;
  invocations: Map<string, { state: InvocationState; effectKey: EffectKey; effectClass: EffectClass }>;
  cell: Map<string, unknown>;
  executedKeys: Map<EffectKey, InvocationState>;
  protectedKeys: Set<EffectKey>;
  grants: Map<string, ModelGrant>;
  artifactCount: number;
}

export class ReferenceModel {
  readonly executions = new Map<string, ModelExecution>();

  createExecution(id: string): void {
    this.executions.set(id, {
      id,
      invocations: new Map(),
      cell: new Map(),
      executedKeys: new Map(),
      protectedKeys: new Set(),
      grants: new Map(),
      artifactCount: 0,
    });
  }

  issueGrant(execId: string, id: string, rights: string[], limits: Record<string, number>): void {
    this.exec(execId).grants.set(id, { id, rights, limits, reserved: {}, settled: {}, revoked: false });
  }

  attenuate(execId: string, parentId: string, id: string, rights: string[], limits: Record<string, number>): boolean {
    const e = this.exec(execId);
    const p = e.grants.get(parentId);
    if (p === undefined) return false;
    if (rights.some((r) => !p.rights.includes(r))) return false;
    for (const [u, v] of Object.entries(limits)) {
      const remaining = (p.limits[u] ?? 0) - (p.reserved[u] ?? 0) - (p.settled[u] ?? 0);
      if (v > remaining) return false;
    }
    e.grants.set(id, { id, parent: parentId, rights, limits, reserved: {}, settled: {}, revoked: false });
    return true;
  }

  revoke(execId: string, grantId: string): void {
    const e = this.exec(execId);
    const walk = (id: string): void => {
      const g = e.grants.get(id);
      if (g === undefined || g.revoked) return;
      g.revoked = true;
      for (const [cid, c] of e.grants) if (c.parent === id) walk(cid);
    };
    walk(grantId);
  }

  /** Returns the expected outcome of an invocation attempt. */
  invoke(
    execId: string,
    invocationId: string,
    grantId: string,
    effectKey: EffectKey,
    effectClass: EffectClass,
    outcome: 'ok' | 'fail',
    opts: { evidencePasses?: boolean; requiresEvidence?: boolean; landsExternal?: boolean } = {},
  ): { state: InvocationState | 'denied' | 'deduplicated' | 'refused' } {
    const e = this.exec(execId);

    // Dedup: an effect key already executed in this lineage does not execute again.
    const prior = e.executedKeys.get(effectKey);
    if (prior !== undefined) return { state: 'deduplicated' };

    // Protected irreversible effects may never be re-executed.
    if (e.protectedKeys.has(effectKey)) return { state: 'refused' };

    // Authority: any revoked grant in the chain denies admission.
    for (const g of this.chain(e, grantId)) {
      if (g.revoked) return { state: 'denied' };
      const remaining = (g.limits['invocations'] ?? 0) - (g.reserved['invocations'] ?? 0) - (g.settled['invocations'] ?? 0);
      if (remaining < 1) return { state: 'denied' };
    }

    // Reserve.
    for (const g of this.chain(e, grantId)) {
      g.reserved['invocations'] = (g.reserved['invocations'] ?? 0) + 1;
    }

    let final: InvocationState;
    if (outcome === 'fail') {
      final = 'failed';
    } else if (opts.requiresEvidence === true && opts.evidencePasses !== true) {
      final = 'failed'; // commit gate
    } else {
      final = 'completed';
    }

    // Settle or release.
    for (const g of this.chain(e, grantId)) {
      g.reserved['invocations'] = Math.max(0, (g.reserved['invocations'] ?? 0) - 1);
      if (final === 'completed') g.settled['invocations'] = (g.settled['invocations'] ?? 0) + 1;
    }

    e.invocations.set(invocationId, { state: final, effectKey, effectClass });
    e.executedKeys.set(effectKey, final);
    if (final === 'completed' && effectClass === 'external-irreversible' && opts.landsExternal !== false) {
      e.protectedKeys.add(effectKey);
    }
    return { state: final };
  }

  /** Fork inherits state at the cut ONLY. Post-cut parent effects are invisible. */
  fork(parentId: string, childId: string, cutSnapshot: {
    cell: Map<string, unknown>;
    executedKeys: Map<EffectKey, InvocationState>;
    protectedKeys: Set<EffectKey>;
    grants: Map<string, ModelGrant>;
    cutSeq: number;
    artifactCount: number;
  }): void {
    this.executions.set(childId, {
      id: childId,
      parent: { id: parentId, cutSeq: cutSnapshot.cutSeq },
      invocations: new Map(),
      cell: new Map(cutSnapshot.cell),
      executedKeys: new Map(cutSnapshot.executedKeys),
      protectedKeys: new Set(cutSnapshot.protectedKeys),
      grants: new Map([...cutSnapshot.grants].map(([k, g]) => [k, { ...g, reserved: { ...g.reserved }, settled: { ...g.settled } }])),
      artifactCount: cutSnapshot.artifactCount,
    });
  }

  setState(execId: string, key: string, value: unknown): void {
    this.exec(execId).cell.set(key, value);
  }

  private chain(e: ModelExecution, id: string): ModelGrant[] {
    const out: ModelGrant[] = [];
    let cur: string | undefined = id;
    while (cur !== undefined) {
      const g: ModelGrant | undefined = e.grants.get(cur);
      if (g === undefined) break;
      out.push(g);
      cur = g.parent;
    }
    return out;
  }

  exec(id: string): ModelExecution {
    const e = this.executions.get(id);
    if (e === undefined) throw new Error(`model: unknown execution ${id}`);
    return e;
  }
}
