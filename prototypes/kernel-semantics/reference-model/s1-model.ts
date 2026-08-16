/**
 * Independent reference model for the S1 record format.
 *
 * WHAT MAKES IT INDEPENDENT: this file imports nothing from `src/s1-fold.ts`,
 * `src/s1-kernel.ts` or `src/s1-invariants.ts`. It never sees an event, a hash chain, a
 * commit record or a projection. It is a direct statement of the intended semantics,
 * written from the specification rather than from the implementation, and it answers the
 * same questions the kernel answers.
 *
 * That independence is the entire value. A model derived from the fold would agree with
 * the fold by construction and prove nothing — it would reproduce the implementation's
 * bugs faithfully. This one can disagree, and when it does, one of the two is wrong and
 * we have to find out which.
 *
 * It models exactly the observable semantics:
 *   - is this invocation admitted, deduplicated, or denied (and why)?
 *   - how many times may the world be touched for a given effect key?
 *   - what capacity remains on a grant, in each unit?
 *   - is this effect key protected within the family?
 */

export type ModelEffectClass =
  | 'pure' | 'local' | 'external-idempotent' | 'external-compensatable' | 'external-irreversible';

export type ModelOutcome =
  | { kind: 'admitted'; dispatched: true }
  | { kind: 'deduplicated' }
  | { kind: 'denied'; reason: 'protected' | 'claim-busy' | 'budget' | 'authorization' };

/** Independently restated: which classes may not be repeated. */
function exclusive(cls: ModelEffectClass): boolean {
  return cls === 'external-irreversible' || cls === 'external-compensatable';
}

interface ModelGrantEntry {
  id: string;
  parent: string | undefined;
  rights: string[];
  limits: Record<string, number>;
  reserved: Record<string, number>;
  settled: Record<string, number>;
  revoked: boolean;
}

interface ModelClaim {
  key: string;
  cls: ModelEffectClass;
  state: 'held' | 'landed' | 'uncertain' | 'settled';
  holder: string;
}

export interface ModelUnitPolicy { perInvocation: number; metered: boolean }

/**
 * One lineage tree. Both ledgers are family-wide: an effect landed anywhere binds the
 * whole tree, and a budget spent anywhere is spent for the whole tree.
 */
export class S1Model {
  private readonly grants = new Map<string, ModelGrantEntry>();
  private readonly claims = new Map<string, ModelClaim>();
  /** Landed effects and the class they landed under; the class decides protection. */
  private readonly landed = new Map<string, ModelEffectClass>();
  private readonly terminalOutcome = new Map<string, 'completed' | 'failed'>();
  private readonly invocations = new Map<string, {
    key: string; cls: ModelEffectClass; grantId: string;
    state: 'dispatched' | 'suspended' | 'uncertain' | 'completed' | 'failed';
    reservation: Record<string, number>;
  }>();
  /** How many times the world was told to apply each key. */
  readonly worldApplications = new Map<string, number>();

  issueGrant(id: string, rights: string[], limits: Record<string, number>, parent?: string): void {
    this.grants.set(id, { id, parent, rights, limits, reserved: {}, settled: {}, revoked: false });
  }

  revoke(id: string): void {
    // Transitive: every grant reachable downward from this one dies with it.
    const dead = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of this.grants.values()) {
        if (g.parent !== undefined && dead.has(g.parent) && !dead.has(g.id)) { dead.add(g.id); grew = true; }
      }
    }
    for (const gid of dead) {
      const g = this.grants.get(gid);
      if (g !== undefined) g.revoked = true;
    }
  }

  /** Capacity for one unit: the tightest constraint anywhere along the chain. */
  remaining(grantId: string, unit: string): number {
    let min = Number.POSITIVE_INFINITY;
    let cur: string | undefined = grantId;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const g: ModelGrantEntry | undefined = this.grants.get(cur);
      if (g === undefined) break;
      if (Object.prototype.hasOwnProperty.call(g.limits, unit)) {
        min = Math.min(min, g.limits[unit]! - (g.reserved[unit] ?? 0) - (g.settled[unit] ?? 0));
      }
      cur = g.parent;
    }
    // A unit nobody granted is a unit you have none of.
    return min === Number.POSITIVE_INFINITY ? 0 : min;
  }

  private blocked(grantId: string): boolean {
    let cur: string | undefined = grantId;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const g: ModelGrantEntry | undefined = this.grants.get(cur);
      if (g === undefined) return true;
      if (g.revoked) return true;
      cur = g.parent;
    }
    return false;
  }

  private move(grantId: string, units: Record<string, number>, bucket: 'reserved' | 'settled', sign: 1 | -1): void {
    let cur: string | undefined = grantId;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const g: ModelGrantEntry | undefined = this.grants.get(cur);
      if (g === undefined) break;
      for (const [u, amount] of Object.entries(units)) {
        g[bucket][u] = Math.max(0, (g[bucket][u] ?? 0) + sign * amount);
      }
      cur = g.parent;
    }
  }

  isProtected(key: string): boolean {
    const cls = this.landed.get(key);
    // Only classes that cannot be safely repeated are protected. An idempotent effect is
    // repeatable by declaration, so reporting it as protected would be a lie.
    return cls !== undefined && exclusive(cls);
  }

  /**
   * Decide an invocation the way the specification says it should be decided. Order
   * matters and is stated here independently: protection, then dedup, then claim, then
   * authority, then budget.
   */
  admit(
    invocationId: string, key: string, cls: ModelEffectClass, grantId: string,
    unitPolicy: Record<string, ModelUnitPolicy>, estimate: Record<string, number>,
  ): ModelOutcome {
    // Not gated on the newcomer's class: protection is a property of what LANDED.
    if (this.isProtected(key)) return { kind: 'denied', reason: 'protected' };

    if (!exclusive(cls) && this.terminalOutcome.has(key)) return { kind: 'deduplicated' };

    const claim = this.claims.get(key);
    if (claim !== undefined && (exclusive(cls) || exclusive(claim.cls))) {
      return { kind: 'denied', reason: 'claim-busy' };
    }

    if (this.blocked(grantId)) return { kind: 'denied', reason: 'authorization' };

    const reservation: Record<string, number> = { invocations: 1 };
    for (const [u, p] of Object.entries(unitPolicy)) {
      reservation[u] = Math.max(reservation[u] ?? 0, p.perInvocation);
    }
    for (const [u, amount] of Object.entries(estimate)) {
      reservation[u] = Math.max(reservation[u] ?? 0, amount);
    }
    for (const [u, amount] of Object.entries(reservation)) {
      if (amount > this.remaining(grantId, u)) return { kind: 'denied', reason: 'budget' };
    }

    this.move(grantId, reservation, 'reserved', +1);
    this.claims.set(key, { key, cls, state: 'held', holder: invocationId });
    this.invocations.set(invocationId, { key, cls, grantId, state: 'dispatched', reservation });
    return { kind: 'admitted', dispatched: true };
  }

  /**
   * The capability touched the world. Recorded at the moment it is reported.
   *
   * A capability whose declared class is NOT external may still report a landing. That is
   * a misdeclaration, but the report is about the world and is never discarded: it is
   * recorded at the strictest class so protection engages.
   */
  land(invocationId: string): void {
    const inv = this.invocations.get(invocationId);
    if (inv === undefined) return;
    const effective: ModelEffectClass =
      inv.cls.startsWith('external') ? inv.cls : 'external-irreversible';
    if (!this.landed.has(inv.key)) {
      this.landed.set(inv.key, effective);
      const c = this.claims.get(inv.key);
      if (c !== undefined) c.state = 'landed';
    }
    this.worldApplications.set(inv.key, (this.worldApplications.get(inv.key) ?? 0) + 1);
  }

  suspend(invocationId: string): void {
    const inv = this.invocations.get(invocationId);
    if (inv !== undefined) inv.state = 'suspended';
    // The lease is retained: neither the claim nor the reservation is released.
  }

  settle(
    invocationId: string, outcome: 'completed' | 'failed',
    declared: Record<string, number>, unitPolicy: Record<string, ModelUnitPolicy>,
  ): void {
    const inv = this.invocations.get(invocationId);
    if (inv === undefined) return;

    const charge: Record<string, number> = {};
    for (const [u, held] of Object.entries(inv.reservation)) {
      const d = declared[u];
      const metered = unitPolicy[u]?.metered === true;

      // `invocations` is consumed by the ACT of invoking, whatever the outcome. This is
      // what bounds a retry loop: everything else may be refunded on failure, but the
      // attempt itself always costs.
      if (u === 'invocations') { charge[u] = held; continue; }

      // Any other unit, on a non-completed outcome: charge only what was evidenced.
      // There is no reason to believe unmetered work happened if the work failed, and
      // burning the reservation on every transient failure would make retries eat budget.
      if (outcome !== 'completed') { charge[u] = Math.min(d ?? 0, held); continue; }

      // Completed: a metered declaration is believed downward; an unmetered one is not.
      charge[u] = d !== undefined && metered ? Math.min(d, held) : held;
    }

    this.move(inv.grantId, inv.reservation, 'reserved', -1);
    this.move(inv.grantId, charge, 'settled', +1);

    inv.state = outcome;
    const c = this.claims.get(inv.key);
    if (this.landed.has(inv.key)) {
      if (c !== undefined) c.state = 'settled';
      // A FAILURE THAT LANDED still occupies the key. The distinction is whether the
      // world was touched, not whether the capability liked the result: a transient
      // failure that never reached the world stays retryable, and one that did does not.
      this.terminalOutcome.set(inv.key, outcome);
    } else {
      // Nothing reached the world, so the key is free for another attempt.
      this.claims.delete(inv.key);
      if (outcome === 'completed') this.terminalOutcome.set(inv.key, outcome);
    }
  }

  /** A crash left this invocation's outcome unknown. */
  markUncertain(invocationId: string): void {
    const inv = this.invocations.get(invocationId);
    if (inv === undefined) return;
    inv.state = 'uncertain';
    const c = this.claims.get(inv.key);
    if (c !== undefined) c.state = 'uncertain';
  }

  stateOf(invocationId: string): string | undefined { return this.invocations.get(invocationId)?.state; }
  claimState(key: string): string | undefined { return this.claims.get(key)?.state; }
  worldCount(key: string): number { return this.worldApplications.get(key) ?? 0; }
}
