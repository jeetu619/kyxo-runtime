/**
 * Wave S1 kernel — record format `2026-08-17`.
 *
 * Differences from the phase-2 kernel that matter:
 *   B1  effect claims are committed at admission, before dispatch;
 *   B2  one family-scoped grant ledger, every unit reserved and settled;
 *   B3  landed external effects commit at yield, not at settlement;
 *   B4  all derived state comes from s1-fold; the kernel keeps no private index;
 *   B8  payloadHash in the envelope, chain covers the hash;
 *   B9a protection is a family-wide ledger over landed effects, not a snapshot list.
 *
 * CONCURRENCY CONTRACT (see docs/25 §Single writer): one writer per family. Admission —
 * claim check plus claim commit — is synchronous and contains no await, so no two
 * invocations can interleave between checking and claiming within a process. Multi-writer
 * safety would require storage-level compare-and-set and is NOT claimed.
 */

import {
  type ClaimId, type FamilyId, type FamilyProjection, type S1Event, type S1EventKind,
  type Units, emptyFamily, requiresExclusiveClaim, S1_PROTOCOL_VERSION,
} from './s1-types.ts';
import { chainBlocked, foldEvent, hasLanded, protectionFor, remaining } from './s1-fold.ts';
import type {
  CapabilityProvider, EffectClass, EffectKey, EffectProposal, ExecutionId,
  GrantId, InvocationId, InvocationState, PolicyStage, UncertaintyDisposition, UnitPolicy,
} from './types.ts';
import { GrantHandle } from './types.ts';
import { CrashError, Storage, canonical, sha } from './storage.ts';

export class S1Error extends Error {}
export class ClaimDeniedError extends S1Error {}
export class AuthorizationError extends S1Error {}
export class BudgetError extends S1Error {}
export class ForkError extends S1Error {}
/** Raised when the journal is corrupt in a way recovery must not paper over (B6). */
export class JournalIntegrityError extends S1Error {}
/**
 * Raised when a durable write failed in a way that leaves its outcome UNKNOWN.
 *
 * Distinct from every other error the kernel raises, because it is the only one that means
 * "I do not know what the world or the journal now contains." It must never be downgraded
 * into a settled failure — that is exactly the bug it exists to prevent (docs/20 F-27).
 */
export class CommitFailedError extends S1Error {}

interface Draft {
  readonly kind: S1EventKind;
  readonly invocationId?: InvocationId | undefined;
  readonly grantId?: GrantId | undefined;
  readonly causationId?: string | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly string[] | undefined;
}

export interface S1InvokeOptions {
  readonly step?: string;
  readonly requiresEvidence?: boolean;
  readonly duplicateDelivery?: boolean;
  readonly effectClassOverride?: EffectClass;
  /** Units the caller expects to consume; reserved at admission in every unit (B9b). */
  readonly estimate?: Units;
}

/**
 * S1 record format: the checksum covers the WHOLE record, not just the events (review #2
 * found that an events-only checksum left the envelope — commit token, execution, family —
 * unprotected, so a record could be re-attributed without detection).
 */
export function verifyS1Record(record: unknown): boolean {
  const rec = record as { commitToken?: unknown; executionId?: unknown; familyId?: unknown; events?: unknown; checksum?: unknown };
  if (typeof rec.checksum !== 'string') return false;
  return rec.checksum === sha({
    commitToken: rec.commitToken, executionId: rec.executionId, familyId: rec.familyId, events: rec.events,
  });
}

/**
 * Copy an untrusted value into kernel-owned plain data, ONCE, at the boundary.
 *
 * THE ROOT CAUSE OF MOST OF THIS WAVE'S SECURITY DEFECTS (docs/20 F-36). Six separate
 * findings were the same mistake wearing different clothes: the kernel read a field it did
 * not own more than once, or kept a reference to it.
 *
 *   - `proposal.landed` read twice: a getter answering false-then-true walked between the
 *     guard and the recorder.
 *   - `evidence.verdict` read twice: an invocation completed while the only evidence record
 *     in the journal said `fail` — review #2's FATAL through a new door.
 *   - `request` retained by reference: a capability mutating `ctx.request` made live state
 *     disagree with the journal, falsifying S1-I3 with no journal access at all.
 *   - `manifest.units` / `traits.effectClass` re-read per invocation from a live provider
 *     object, so "fixed before the invocation" was not.
 *
 * Patching instances produces new instances. A value that crosses into the kernel is
 * snapshotted here and never re-read from the caller's object again.
 */
function snapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    canonical(value);                       // reject what the format cannot represent
    return value;
  }
  if (Array.isArray(value)) return value.map(snapshot) as unknown as T;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    canonical(value);                       // throws with the explanatory message
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];   // read ONCE
    if (v !== undefined) out[key] = snapshot(v);
  }
  return Object.freeze(out) as unknown as T;
}

/** The units this capability declares as provider-metered, in a stable order. */
function meteredOf(policy: Readonly<Record<string, UnitPolicy>> | undefined): string[] {
  return Object.entries(policy ?? {}).filter(([, p]) => p.metered).map(([u]) => u).sort();
}

/** Per-unit reservation: max(capability floor, caller estimate), plus one invocation. */
function reserveUnits(
  policy: Readonly<Record<string, UnitPolicy>> | undefined,
  estimate: Units | undefined,
): Units {
  // Every unit amount must be a finite, non-negative number BEFORE it reaches the ledger.
  //
  // `NaN` is a number, so `estimate: { usd: NaN }` was not even a type error. It then beat
  // every check by the same trick each time: `NaN > available` is false, so admission
  // allowed it; it propagated into the ledger; `remaining()` returned NaN forever after;
  // and S1-I5 could not see it, because every comparison against NaN is false. One
  // type-correct field permanently disabled budget enforcement family-wide, and the budget
  // silently reset to full on the next restart because NaN serialises to null
  // (docs/20 F-28, found by adversarial review).
  const declared = [
    ...Object.entries(policy ?? {}).map(([u, pol]) => [u, pol.perInvocation] as const),
    ...Object.entries(estimate ?? {}),
  ];
  for (const [unit, amount] of declared) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new BudgetError(`unit ${unit} must be a finite non-negative number, got ${String(amount)}`);
    }
  }
  const out: Record<string, number> = { invocations: 1 };
  for (const [unit, p] of Object.entries(policy ?? {})) {
    out[unit] = Math.max(out[unit] ?? 0, p.perInvocation);
  }
  for (const [unit, amount] of Object.entries(estimate ?? {})) {
    out[unit] = Math.max(out[unit] ?? 0, amount);
  }
  return out;
}

type AdmissionDecision =
  | { readonly admitted: true; readonly reservation: Units }
  /** Resolved without a claim (dedup, duplicate delivery): return this outcome verbatim. */
  | { readonly admitted: false; readonly outcome: S1Outcome };

/** Raised when the admission critical section is re-entered. See `inAdmission`. */
export class AdmissionReentrancyError extends S1Error {}

export interface S1Outcome {
  readonly invocationId: InvocationId;
  readonly state: InvocationState;
  readonly output?: unknown;
  readonly error?: string;
  readonly deduplicated?: boolean;
}

export class S1Kernel {
  private readonly storage: Storage;
  private readonly caps = new Map<string, CapabilityProvider>();
  private readonly policies: PolicyStage[] = [];
  private readonly families = new Map<FamilyId, FamilyProjection>();
  private readonly familyOf = new Map<ExecutionId, FamilyId>();
  private readonly mintedHandles = new WeakSet<GrantHandle>();
  private readonly staged = new Map<InvocationId, EffectProposal[]>();
  private counter = 0;
  private clock = 0;
  /**
   * Guard for the admission critical section. Admission is correct because it is one
   * synchronous region: check-then-claim cannot be split. Two things could break that —
   * an `await` inside the region (caught statically by the no-await guard test) or
   * re-entrancy (caught here, at runtime). Without this flag the region's atomicity is
   * a comment; with it, a violation is a loud failure instead of a double dispatch.
   */
  private inAdmission = false;
  /** Test hook: run a callback at the admission race point. */
  raceHook: (() => void) | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  register(p: CapabilityProvider): void { this.caps.set(p.manifest.id, p); }
  addPolicy(s: PolicyStage): void { this.policies.push(s); }
  tick(n = 1): number { this.clock += n; return this.clock; }
  private id(prefix: string): string { this.counter += 1; return `${prefix}_${String(this.counter).padStart(6, '0')}`; }

  // -------------------------------------------------------------------------
  // Executions and lineage
  // -------------------------------------------------------------------------

  createExecution(opts?: { definitionHash?: string }): ExecutionId {
    const execId = this.id('exec') as ExecutionId;
    const familyId = execId as unknown as FamilyId;   // root execution names the family
    this.families.set(familyId, emptyFamily(familyId));
    this.familyOf.set(execId, familyId);
    this.commit(familyId, execId, [{
      kind: 'execution.created',
      payload: { definitionHash: opts?.definitionHash ?? 'D1' },
    }]);
    return execId;
  }

  fork(parentExec: ExecutionId, cutSeq: number, opts?: { definitionHash?: string }): ExecutionId {
    const familyId = this.mustFamilyId(parentExec);
    const fam = this.family(familyId);
    const parent = fam.executions.get(parentExec);
    if (parent === undefined) throw new ForkError(`unknown execution ${parentExec}`);
    if (cutSeq > parent.seq) throw new ForkError(`cut ${cutSeq} is past the parent tip ${parent.seq}`);

    // Cell state at the cut is computed from the fold, then carried IN the fork record,
    // so the child's journal is self-sufficient (F-8) without a checkpoint blob.
    const cellAtCut = this.cellAt(familyId, parentExec, cutSeq);
    const childId = this.id('exec') as ExecutionId;
    this.familyOf.set(childId, familyId);
    this.commit(familyId, childId, [{
      kind: 'execution.forked',
      payload: {
        parentExecution: parentExec,
        cutSeq,
        definitionHash: opts?.definitionHash ?? parent.definitionHash,
        inheritedCell: [...cellAtCut.entries()],
        inheritedArtifacts: [],
      },
    }]);
    return childId;
  }

  /** Replay this execution's own records up to `cutSeq` to obtain its cell state. */
  private cellAt(familyId: FamilyId, execId: ExecutionId, cutSeq: number): Map<string, unknown> {
    const cell = new Map<string, unknown>();
    // Inherited state arrives via the fork record itself, then own state.updated events.
    for (const ev of this.events(familyId)) {
      if (ev.executionId !== execId || ev.seq > cutSeq) continue;
      if (ev.kind === 'execution.forked') {
        for (const [k, v] of (ev.payload['inheritedCell'] as [string, unknown][] | undefined) ?? []) cell.set(k, v);
      } else if (ev.kind === 'state.updated') {
        cell.set(ev.payload['key'] as string, ev.payload['value']);
      }
    }
    return cell;
  }

  // -------------------------------------------------------------------------
  // Grants — family-scoped ledger
  // -------------------------------------------------------------------------

  issueGrant(execId: ExecutionId, spec: { rights: readonly string[]; limits: Units; expiresAt?: number }): GrantHandle {
    const familyId = this.mustFamilyId(execId);
    const gid = this.id('grant') as GrantId;
    this.commit(familyId, execId, [{
      kind: 'grant.issued', grantId: gid,
      payload: { rights: [...spec.rights], limits: { ...spec.limits }, expiresAt: spec.expiresAt },
    }]);
    return this.mint(gid);
  }

  attenuate(execId: ExecutionId, parent: GrantHandle, spec: { rights: readonly string[]; limits: Units }): GrantHandle {
    const familyId = this.mustFamilyId(execId);
    const fam = this.family(familyId);
    this.authorize(fam, parent);
    const pg = fam.grants.get(parent.id)!;
    for (const r of spec.rights) {
      if (!pg.rights.includes(r)) throw new AuthorizationError(`attenuation cannot add right ${r}`);
    }
    for (const [unit, amount] of Object.entries(spec.limits)) {
      const avail = remaining(fam, pg.id, unit);
      if (amount > avail) throw new AuthorizationError(`attenuation exceeds remaining ${unit}: ${amount} > ${avail}`);
    }
    const gid = this.id('grant') as GrantId;
    this.commit(familyId, execId, [{
      kind: 'grant.attenuated', grantId: gid,
      payload: { parent: pg.id, rights: [...spec.rights], limits: { ...spec.limits }, expiresAt: pg.expiresAt },
    }]);
    return this.mint(gid);
  }

  revoke(execId: ExecutionId, handle: GrantHandle): void {
    const familyId = this.mustFamilyId(execId);
    const fam = this.family(familyId);
    this.authorize(fam, handle);
    const drafts: Draft[] = [];
    const walk = (id: GrantId): void => {
      const g = fam.grants.get(id);
      if (g === undefined || g.revoked) return;
      drafts.push({ kind: 'grant.revoked', grantId: id, payload: { transitive: id !== handle.id } });
      for (const [cid, c] of fam.grants) if (c.parent === id && !c.revoked) walk(cid);
    };
    walk(handle.id);
    if (drafts.length > 0) this.commit(familyId, execId, drafts);
  }

  private mint(id: GrantId): GrantHandle {
    const h = new GrantHandle(id);
    this.mintedHandles.add(h);
    return h;
  }

  /**
   * Re-mint a handle for a grant that already exists in the recovered family ledger.
   *
   * The WeakSet of minted handles is process memory, so after a restart no handle exists
   * for any grant — yet the grants themselves survive, because they are folded records.
   * Rehydration is the bridge, and it does NOT weaken the object-capability property:
   * only the kernel mints handles, and it will only mint one for a grant it can already
   * see in this family's ledger. Revocation, expiry and exhaustion are folded state, so a
   * rehydrated handle is subject to every one of them exactly as the original was — the
   * handle is a reference, never the authority itself.
   */
  rehydrateGrant(execId: ExecutionId, grantId: GrantId): GrantHandle {
    const fam = this.family(this.mustFamilyId(execId));
    if (!fam.grants.has(grantId)) throw new AuthorizationError(`grant ${grantId} not in family`);
    return this.mint(grantId);
  }

  private authorize(fam: FamilyProjection, handle: GrantHandle): void {
    if (!this.mintedHandles.has(handle)) {
      throw new AuthorizationError(`invalid grant handle ${String((handle as { id?: string }).id)}`);
    }
    if (!fam.grants.has(handle.id)) throw new AuthorizationError(`grant ${handle.id} not in family`);
  }

  // -------------------------------------------------------------------------
  // Invocation
  // -------------------------------------------------------------------------

  /**
   * Run the admission critical section.
   *
   * The callback must be synchronous (its type says so: it returns a value, not a
   * promise), and it must not re-enter. Together those two properties are the whole
   * argument for B1's exclusivity in-process: between reading the claim table and
   * committing the claim, no other invocation can run at all.
   *
   * If someone later adds an `await` inside, the callback's return type changes to a
   * promise and the static guard test fails. If someone routes a second invocation into
   * the middle of the region, this throws instead of admitting it.
   */
  private enterAdmission(fn: () => AdmissionDecision): AdmissionDecision {
    if (this.inAdmission) {
      throw new AdmissionReentrancyError(
        're-entered the admission critical section; check-then-claim is not atomic',
      );
    }
    this.inAdmission = true;
    try {
      return fn();
    } finally {
      this.inAdmission = false;
    }
  }

  async invoke(
    execId: ExecutionId,
    capabilityId: string,
    rawRequest: unknown,
    grant: GrantHandle,
    opts: S1InvokeOptions = {},
    depth = 0,
  ): Promise<S1Outcome> {
    const familyId = this.mustFamilyId(execId);
    const fam = this.family(familyId);
    const provider = this.caps.get(capabilityId);
    if (provider === undefined) throw new S1Error(`unknown capability ${capabilityId}`);
    this.authorize(fam, grant);

    // Snapshot before ANY use: the effect key, the journal record and the capability must
    // all see the same bytes, and none of them may see a later mutation (F-36).
    const request = snapshot(rawRequest);
    const effectClass = opts.effectClassOverride ?? provider.manifest.traits.effectClass;
    // Effect identity is RUNTIME-DERIVED from the invocation inputs. A capability cannot
    // choose or vary it (PART 2); the caller's request and step are the only inputs.
    const effectKey = sha({ cap: capabilityId, step: opts.step ?? 'anon', request }) as EffectKey;
    const exclusive = requiresExclusiveClaim(effectClass);
    const invocationId = this.id('inv') as InvocationId;

    // ---------------- ADMISSION: synchronous, no await before the claim commits ------
    // Everything from here to the claim commit is one synchronous region. That is what
    // makes B1's exclusivity real in-process (see the concurrency contract above).
    // Two guards keep that true rather than merely intended: the no-await source guard
    // (tests/s1-concurrency) and the re-entrancy flag below.
    const decision = this.enterAdmission((): AdmissionDecision => {
      // Lineage-tree protection (B9a): has this effect already landed in this family?
      // NOTE the absence of `&& exclusive`. Protection is a property of what LANDED, not
      // of what the newcomer declares itself to be — `protectionFor` has already filtered
      // to landings whose class cannot be repeated. Gating on the caller's class let a
      // capability dodge protection by declaring `local`, which is exactly the manifest
      // a misdeclaring capability has (docs/20 F-22).
      const prot = protectionFor(fam, effectKey);
      if (prot.protected) {
        this.commit(familyId, execId, [{
          kind: 'effect.claim.denied', invocationId, grantId: grant.id,
          payload: { effectKey, reason: 'protected-effect-in-lineage', landedBy: prot.by ?? null },
        }]);
        throw new ClaimDeniedError(`effect ${effectKey} already landed in this lineage`);
      }

      // Terminal outcome for a safe class ⇒ ordinary dedup, journaled (I14).
      const prior = fam.outcomes.get(effectKey);
      if (prior !== undefined && !exclusive) {
        this.commit(familyId, execId, [{
          kind: opts.duplicateDelivery ? 'delivery.duplicate' : 'effect.deduplicated',
          invocationId: prior.invocationId, grantId: grant.id,
          payload: { effectKey, originalInvocation: prior.invocationId, outcome: prior.state },
        }]);
        return {
          admitted: false,
          outcome: { invocationId: prior.invocationId, state: prior.state, output: prior.output, deduplicated: true },
        };
      }

      // Exclusive claim: is the key already held or in doubt?
      const existing = fam.claims.get(effectKey);
      if (existing !== undefined && (exclusive || existing.exclusive)) {
        const blocking = existing.state === 'held' || existing.state === 'uncertain'
          || existing.state === 'landed' || existing.state === 'settled';
        if (blocking) {
          this.commit(familyId, execId, [{
            kind: 'effect.claim.denied', invocationId, grantId: grant.id,
            payload: { effectKey, reason: `claim-${existing.state}`, heldBy: existing.holder },
          }]);
          throw new ClaimDeniedError(`effect ${effectKey} is ${existing.state} (held by ${existing.holder})`);
        }
      }

      // Test hook: fires INSIDE the synchronous admission region, between the claim
      // check and the claim commit — the exact window a broken critical section would
      // expose. The race suite drives a competitor through it.
      this.raceHook?.();

      // Authority and policy, then reservation in every declared unit (B9b).
      const blocked = chainBlocked(fam, grant.id, this.clock);
      if (blocked !== null) {
        this.commit(familyId, execId, [{ kind: 'grant.denied', invocationId, grantId: grant.id, payload: { reason: blocked } }]);
        throw new AuthorizationError(`grant ${grant.id}: ${blocked}`);
      }
      for (const stage of this.policies) {
        const d = stage.evaluate({ capabilityId, effectClass, grant: fam.grants.get(grant.id) as never, phase: 'admission' });
        if (d.decision === 'deny') {
          this.commit(familyId, execId, [{ kind: 'policy.denied', invocationId, grantId: grant.id, payload: { stage: stage.name, reason: d.reason } }]);
          throw new AuthorizationError(`policy denied: ${d.reason}`);
        }
      }
      // The reservation is the union of what the capability declares it consumes and what
      // the caller estimates, taking the larger of the two per unit. Neither side can
      // shrink it: a caller omitting `estimate` would otherwise make every non-invocation
      // budget opt-in, which is B9b in a new costume (docs/20 F-15).
      const res: Units = reserveUnits(provider.manifest.units, opts.estimate);
      for (const [unit, amount] of Object.entries(res)) {
        const avail = remaining(fam, grant.id, unit);
        if (amount > avail) {
          this.commit(familyId, execId, [{ kind: 'grant.denied', invocationId, grantId: grant.id, payload: { reason: 'budget-exhausted', unit, requested: amount, available: avail } }]);
          throw new BudgetError(`budget exhausted: ${unit} ${amount} > ${avail}`);
        }
      }

      const claimId = this.id('claim') as ClaimId;
      this.commit(familyId, execId, [
        { kind: 'invocation.admitted', invocationId, grantId: grant.id,
          payload: {
            capabilityId, request, effectKey, effectClass,
            requiresEvidence: opts.requiresEvidence === true,
            meteredUnits: meteredOf(provider.manifest.units),
          } },
        { kind: 'effect.claimed', invocationId, grantId: grant.id,
          payload: { claimId, effectKey, effectClass, exclusive } },
        { kind: 'grant.reserved', invocationId, grantId: grant.id, payload: { units: res } },
        { kind: 'invocation.dispatched', invocationId, grantId: grant.id,
          payload: { effectKey, effectClass, external: effectClass.startsWith('external') } },
      ]);
      return { admitted: true, reservation: res };
    });
    // ---------------- END synchronous admission region ------------------------------
    if (!decision.admitted) return decision.outcome;
    const reservation = decision.reservation;

    return this.run({
      familyId, execId, invocationId, provider, grant, request, effectKey, effectClass,
      reservation, depth, attempt: 1,
    });
  }

  /**
   * Re-enter a suspended invocation.
   *
   * Suspension without resumption is a one-way door: the claim and the reservation stay
   * held forever, so the effect key is permanently occupied and the budget permanently
   * spent. Resume closes it.
   *
   * What resume must NOT do: re-admit. The claim is already held by this invocation and
   * the budget is already reserved for it, so re-running admission would either be denied
   * by its own claim or double-charge the ledger. It picks up the existing lease instead,
   * reading the reservation from the fold (not from memory, which a restart would have
   * lost).
   */
  async resume(execId: ExecutionId, invocationId: InvocationId, payload: unknown): Promise<S1Outcome> {
    const familyId = this.mustFamilyId(execId);
    const fam = this.family(familyId);
    const inv = fam.executions.get(execId)?.invocations.get(invocationId);
    if (inv === undefined) throw new S1Error(`unknown invocation ${invocationId}`);
    if (inv.state !== 'suspended') throw new S1Error(`invocation ${invocationId} is not suspended (${inv.state})`);
    const provider = this.caps.get(inv.capabilityId);
    if (provider === undefined) throw new S1Error(`unknown capability ${inv.capabilityId}`);

    // Resume dispatches to the world, so it passes the same gates admission does. It used
    // to check only "is it suspended", so a grant revoked or expired while the invocation
    // waited did not bind the resume, and a deny-class policy stage — the documented
    // kill switch — was bypassed entirely while the invocation reported `completed`
    // (docs/20 F-29, found by adversarial review). A gate that closes once the horse has
    // left is not a gate, which is the sentence ADR-024 opens with.
    const blocked = chainBlocked(fam, inv.grantId, this.clock);
    if (blocked !== null) {
      this.commit(familyId, execId, [{ kind: 'grant.denied', invocationId, grantId: inv.grantId,
        payload: { reason: blocked, at: 'resume' } }]);
      throw new AuthorizationError(`grant ${inv.grantId}: ${blocked}`);
    }
    for (const stage of this.policies) {
      const d = stage.evaluate({
        capabilityId: inv.capabilityId, effectClass: inv.effectClass,
        grant: fam.grants.get(inv.grantId) as never, phase: 'admission',
      });
      if (d.decision === 'deny') {
        this.commit(familyId, execId, [{ kind: 'policy.denied', invocationId, grantId: inv.grantId,
          payload: { stage: stage.name, reason: d.reason, at: 'resume' } }]);
        throw new AuthorizationError(`policy denied: ${d.reason}`);
      }
    }

    this.commit(familyId, execId, [{
      kind: 'invocation.resumed', invocationId, grantId: inv.grantId,
      payload: { effectKey: inv.effectKey, payload },
    }]);

    return this.run({
      familyId, execId, invocationId, provider,
      grant: this.mint(inv.grantId),            // kernel-minted, so authority is unchanged
      request: inv.request,
      effectKey: inv.effectKey, effectClass: inv.effectClass,
      reservation: inv.reservation, depth: 0, attempt: 2,
      resume: { payload },
    });
  }

  /** The half of an invocation that runs the capability. Shared by invoke and resume. */
  private async run(a: {
    familyId: FamilyId; execId: ExecutionId; invocationId: InvocationId;
    provider: CapabilityProvider; grant: GrantHandle; request: unknown;
    effectKey: EffectKey; effectClass: EffectClass; reservation: Units;
    depth: number; attempt: number; resume?: { payload: unknown };
  }): Promise<S1Outcome> {
    const { familyId, execId, invocationId, provider, grant, effectKey, effectClass, reservation } = a;
    this.staged.set(invocationId, []);
    const ctx = {
      invocationId, executionId: execId, now: this.tick(), attempt: a.attempt, request: a.request,
      ...(a.resume === undefined ? {} : { resume: a.resume }),
      cancelled: () => this.family(familyId).executions.get(execId)?.cancelRequested.has(invocationId) === true,
    };

    let result: { status: 'ok'; output: unknown } | { status: 'failed'; error: string } | { status: 'suspend'; reason: string; payload: unknown };
    try {
      const gen = provider.invoke(ctx);
      let next = await gen.next();
      while (!next.done) {
        // One read of the capability's object, into kernel-owned data. Every guard and
        // every record below then sees the same values (F-36).
        const proposal = snapshot(next.value);
        if (proposal.type === 'external' && proposal.landed) {
          // A landing reported by a capability whose DECLARED CLASS is not external is a
          // misdeclaration. The first fix for that (F-19) refused the landing and recorded
          // only a policy denial — which was worse than the bug it fixed. The original bug
          // recorded a true fact and failed to act on it; the fix DESTROYED the fact, so
          // `hasLanded` was false, protection never engaged, and the next attempt hit the
          // world again (docs/20 F-22, found by adversarial review).
          //
          // A report that the world changed is never discarded. Instead the effect is
          // recorded at the strictest class — irreversible — so that protection engages,
          // and the misdeclaration is journaled beside it. Punishing a bad manifest by
          // forgetting what it told us is not a safety measure.
          const misdeclared = !effectClass.startsWith('external');
          const landedClass: EffectClass = misdeclared ? 'external-irreversible' : effectClass;
          const drafts: Draft[] = [];
          if (misdeclared) {
            drafts.push({
              kind: 'policy.denied', invocationId, grantId: grant.id,
              payload: {
                reason: 'external-landing-from-non-external-class',
                effectKey, declaredClass: effectClass, recordedAs: landedClass,
                descriptor: proposal.descriptor,
              },
            });
          }
          // B3: world truth commits AT YIELD. A later suspension, crash or failure
          // cannot erase it, because it is no longer a candidate.
          //
          // A resumed capability re-runs its body, so it may re-yield a landing that is
          // already recorded. The kernel records that as a duplicate rather than a second
          // landing, which keeps the ledger coherent. It CANNOT undo a real second call to
          // the world — a capability re-entered after suspension is contractually required
          // to consult `ctx.resume` and skip work it already did. That obligation lives in
          // the capability contract, and tests/s1-effects E7 pins the containment.
          drafts.push(
            hasLanded(this.family(familyId), effectKey)
              ? { kind: 'effect.deduplicated' as const, invocationId, grantId: grant.id,
                  payload: { effectKey, reason: 're-yielded-after-resume', descriptor: proposal.descriptor } }
              : { kind: 'effect.landed' as const, invocationId, grantId: grant.id,
                  payload: { effectKey, effectClass: landedClass, descriptor: proposal.descriptor } },
          );
          this.commit(familyId, execId, drafts);
          next = await gen.next(undefined);
          continue;
        }
        if (proposal.type === 'delegate') {
          const outcome = await this.delegate(familyId, execId, grant, proposal, a.depth, invocationId, effectKey);
          next = await gen.next(outcome);
          continue;
        }
        this.staged.get(invocationId)!.push(proposal);
        next = await gen.next(undefined);
      }
      result = next.value;
    } catch (err) {
      this.staged.delete(invocationId);
      if (err instanceof CrashError) throw err;
      // A COMMIT FAILURE IS NOT AN INVOCATION FAILURE.
      //
      // `settle()` decides whether the world was touched by reading the projection, and
      // the projection only advances AFTER a durable write returns. So a storage error
      // that leaves the bytes durable but loses the ack — fsync timeout, replicated-log
      // ack loss, network FS reset, the single most ordinary durable-storage fault —
      // left memory saying "not landed" while the journal said "landed". Settlement then
      // emitted `effect.released`, the fold deleted the claim, and the orchestrator's
      // perfectly correct retry charged the card a second time. One process, one kernel,
      // ZERO concurrency (docs/20 F-27, found by adversarial review).
      //
      // The kernel cannot tell "not written" from "written, ack lost". So it stops
      // claiming it can: a commit failure is fail-stop for this invocation. The claim
      // stays held, nothing is released, and the operator resolves it through the
      // uncertainty path — which is what that path is for.
      if (err instanceof CommitFailedError) throw err;
      return this.settle(familyId, execId, invocationId, grant.id, effectKey, effectClass, reservation,
        { status: 'failed', error: String(err) });
    }

    try {
      return this.settle(familyId, execId, invocationId, grant.id, effectKey, effectClass, reservation, result);
    } catch (err) {
      if (err instanceof CrashError || err instanceof CommitFailedError) throw err;
      // Settlement itself failed — a payload the format cannot represent, most likely.
      // This used to escape uncaught from OUTSIDE the try/catch, so the invocation never
      // became terminal: its claim stayed held and its reservation was never released,
      // permanently and family-wide, with every invariant green because S1-I6 only
      // inspects terminal invocations (docs/20 F-37, found by adversarial review).
      //
      // The lease must end even when the preferred ending cannot be written.
      this.commit(familyId, execId, [
        { kind: 'invocation.failed', invocationId, grantId: grant.id,
          payload: { effectKey, effectClass, landedExternal: hasLanded(this.family(familyId), effectKey),
            error: `settlement failed: ${String(err)}` } },
        { kind: 'effect.settled', invocationId, grantId: grant.id,
          payload: { effectKey, state: hasLanded(this.family(familyId), effectKey) ? 'settled' : 'released' } },
        { kind: 'grant.settled', invocationId, grantId: grant.id,
          payload: { units: { invocations: 1 }, releasing: reservation } },
      ]);
      throw err;
    }
  }

  private async delegate(
    familyId: FamilyId, execId: ExecutionId, parentHandle: GrantHandle,
    proposal: Extract<EffectProposal, { type: 'delegate' }>, depth: number, parentInvocation: InvocationId,
    parentEffectKey: EffectKey,
  ): Promise<{ state: InvocationState; output?: unknown; error?: string | undefined }> {
    const fam = this.family(familyId);
    const parent = fam.grants.get(parentHandle.id)!;
    const allowedDepth = parent.limits['spawnDepth'] ?? 0;
    if (depth + 1 > allowedDepth) {
      this.commit(familyId, execId, [{ kind: 'policy.denied', invocationId: parentInvocation, grantId: parent.id,
        payload: { reason: 'spawn-depth-exceeded', depth: depth + 1, allowed: allowedDepth } }]);
      return { state: 'failed', error: 'spawn-depth-exceeded' };
    }
    let child: GrantHandle;
    try {
      child = this.attenuate(execId, parentHandle, {
        rights: parent.rights,
        limits: { invocations: Math.max(0, Math.min(remaining(fam, parent.id, 'invocations'), 4)), spawnDepth: allowedDepth - 1 },
      });
    } catch (err) {
      this.commit(familyId, execId, [{ kind: 'policy.denied', invocationId: parentInvocation, grantId: parent.id,
        payload: { reason: 'delegation-attenuation-refused', detail: String(err) } }]);
      return { state: 'failed', error: String(err) };
    }
    try {
      // The default delegation step MUST be stable across retries of the parent. It was
      // `delegate:${parentInvocation}`, and an invocation id is fresh on every attempt —
      // so the kernel itself minted a nonce into the effect key of every delegated
      // external effect, and a retried parent re-charged every irreversible child beneath
      // it (docs/20 F-24, found by adversarial review). Deriving it from the parent's
      // EFFECT KEY makes it a function of the work, not of the attempt.
      const step = proposal.step ?? `delegate:${parentEffectKey}:${proposal.capabilityId}`;
      const out = await this.invoke(execId, proposal.capabilityId, proposal.request, child,
        { step }, depth + 1);
      return { state: out.state, output: out.output, error: out.error };
    } catch (err) {
      if (err instanceof CrashError) throw err;
      return { state: 'failed', error: String(err) };
    }
  }

  private settle(
    familyId: FamilyId, execId: ExecutionId, invocationId: InvocationId, grantId: GrantId,
    effectKey: EffectKey, effectClass: EffectClass, reservation: Units,
    result: { status: 'ok'; output: unknown } | { status: 'failed'; error: string } | { status: 'suspend'; reason: string; payload: unknown },
  ): S1Outcome {
    const fam = this.family(familyId);
    const proposals = this.staged.get(invocationId) ?? [];
    this.staged.delete(invocationId);
    const landed = fam.claims.get(effectKey)?.state === 'landed';

    if (result.status === 'suspend') {
      // B3: the claim and any landed effect persist across the suspension. Only the
      // reservation is retained; nothing about the world is forgotten.
      this.commit(familyId, execId, [{
        kind: 'invocation.suspended', invocationId, grantId,
        payload: { reason: result.reason, payload: result.payload, origin: 'provider', effectKey, landed },
      }]);
      return { invocationId, state: 'suspended' };
    }

    const drafts: Draft[] = [];
    const usage: Record<string, number> = { invocations: 1 };
    let evidencePass = false;
    let evidenceSeen = false;

    // Proposals are read whatever the outcome, because `usage` and `evidence` are
    // OBSERVATIONS about what happened, not OUTPUTS of a successful run. Reading them
    // only on success meant a capability that consumed 5,000 tokens and then failed was
    // charged nothing, so a retry loop could spend without limit for the price of one
    // invocation unit per attempt (docs/20 F-18, found by differential testing).
    //
    // The drafts they produce are still filtered below: state and artifact writes are
    // outputs and must not survive a failure. Only the accounting does.
    {
      for (const p of proposals) {
        switch (p.type) {
          case 'artifact': {
            const ref = this.storage.putBlob(p.content);
            drafts.push({ kind: 'artifact.produced', invocationId, grantId, artifacts: [ref],
              payload: { ref, producedBy: invocationId, labels: p.labels ?? [] } });
            break;
          }
          case 'state':
            drafts.push({ kind: 'state.updated', invocationId, grantId, payload: { key: p.key, value: p.value } });
            break;
          case 'usage':
            for (const [u, v] of Object.entries(p.units)) {
              // A hostile capability reaches the ledger through this path too (F-28).
              if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
                drafts.push({ kind: 'policy.denied', invocationId, grantId,
                  payload: { reason: 'non-finite-usage-declaration', unit: u, declared: String(v) } });
                continue;
              }
              usage[u] = (usage[u] ?? 0) + v;
            }
            break;
          case 'evidence':
            evidenceSeen = true;
            if (p.verdict === 'pass') evidencePass = true;
            drafts.push({ kind: 'evidence.produced', invocationId, grantId, payload: { verdict: p.verdict, detail: p.detail } });
            break;
          default: break;
        }
      }
    }

    const inv = fam.executions.get(execId)?.invocations.get(invocationId);
    const gated = inv?.requiresEvidence === true;
    const cancelled = fam.executions.get(execId)?.cancelRequested.has(invocationId) === true;
    const revoked = chainBlocked(fam, grantId, this.clock);

    let outcome: InvocationState;
    let error: string | undefined;
    if (result.status === 'failed') { outcome = 'failed'; error = result.error; }
    else if (cancelled) { outcome = 'canceled'; }
    else if (revoked !== null) { outcome = 'failed'; error = `authorization-${revoked}-post-hoc`; }
    else if (gated && !(evidenceSeen && evidencePass)) { outcome = 'failed'; error = 'verification-failed'; }
    else { outcome = 'completed'; }

    // B9b: settlement per unit.
    //
    //   ceiling  a declaration can never exceed the reservation. The kernel held N; N is
    //            the most that can be spent, whatever the capability says.
    //   floor    a declaration can only reduce the charge for a METERED unit, where the
    //            provider reports authoritative consumption. For an unmetered unit the
    //            declaration is untrusted code's word about its own spending, so the full
    //            reservation is charged — otherwise a capability declaring zero would run
    //            forever against a finite budget (docs/20 F-15).
    //
    // Every unit that was reserved settles, including ones the capability never mentioned.
    // An invocation that did not complete settles only what was actually evidenced. There
    // is no reason to believe an unmetered unit was consumed by work that failed, and
    // burning the reservation on every transient failure would make retries eat the
    // budget. Failures stay bounded because `invocations` is always reserved and always
    // charged (tests G6, G14).
    // The metering policy comes from the INVOCATION RECORD, negotiated at admission —
    // not from `this.caps`, which is process memory a restart re-supplies from the caller.
    const negotiatedMetered = new Set(inv?.meteredUnits ?? []);
    const cappedUsage: Record<string, number> = {};
    for (const [unit, held] of Object.entries(reservation)) {
      const declared = usage[unit];
      // `invocations` is metered BY THE KERNEL: it counts them itself, so it does not
      // need — or accept — a capability's word about them. This is the one unit whose
      // policy the manifest cannot set, and it is deliberate (ADR-026 §4).
      const metered = unit === 'invocations' ? true : negotiatedMetered.has(unit);
      if (declared !== undefined && declared > held) {
        drafts.push({ kind: 'policy.denied', invocationId, grantId,
          payload: { reason: 'usage-exceeds-reservation', unit, declared, reserved: held } });
      }
      if (outcome !== 'completed') {
        cappedUsage[unit] = Math.min(declared ?? 0, held);
      } else {
        cappedUsage[unit] = declared !== undefined && metered ? Math.min(declared, held) : held;
      }
    }
    for (const [unit, declared] of Object.entries(usage)) {
      if (reservation[unit] !== undefined) continue;
      // Usage declared in a unit nobody reserved. This settled at NOTHING, which made
      // budgets fail OPEN in the most ordinary configuration there is: a capability that
      // declares no `units` at all, against a grant that limits money. Five invocations
      // moved $25,000 against a $5 limit and the ledger reported the budget untouched
      // (docs/20 F-23, found by adversarial review).
      //
      // ADR-026 §4 was careful that an ungranted unit fails CLOSED and silent about this
      // direction, which failed open. The consumption is real and the grant limits it, so
      // it is charged — capped at what remains, since nothing more was ever authorised —
      // and the missing reservation is journaled as the manifest defect it is.
      const room = remaining(fam, grantId, unit);
      const charged = Math.max(0, Math.min(declared, room));
      cappedUsage[unit] = charged;
      drafts.push({ kind: 'policy.denied', invocationId, grantId,
        payload: { reason: 'usage-in-unreserved-unit', unit, declared, charged, room } });
    }

    const finalDrafts: Draft[] = outcome === 'completed' ? drafts : drafts.filter((d) => d.kind === 'evidence.produced' || d.kind === 'policy.denied');

    finalDrafts.push({
      kind: outcome === 'completed' ? 'invocation.completed' : outcome === 'canceled' ? 'invocation.canceled' : 'invocation.failed',
      invocationId, grantId,
      payload: { effectKey, effectClass, landedExternal: landed, ...(outcome === 'completed' ? { output: result.status === 'ok' ? result.output : undefined } : { error }) },
    });
    finalDrafts.push({
      kind: 'effect.settled', invocationId, grantId,
      payload: { effectKey, state: landed ? 'settled' : 'released', landed },
    });
    if (!landed) {
      // The outcome is KNOWN and nothing reached the world, for any class: free the key.
      // (An unknown outcome does not reach here — it commits `invocation.uncertain`
      // instead, which leaves the claim held. See I15.)
      finalDrafts.push({
        kind: 'effect.released', invocationId, grantId,
        // Name the claim being released. Addressing by effect key alone let one
        // invocation revoke another's lease (F-33).
        payload: { effectKey, claimId: fam.claims.get(effectKey)?.claimId ?? null },
      });
    }
    finalDrafts.push({ kind: 'grant.settled', invocationId, grantId, payload: { units: cappedUsage, releasing: reservation } });

    this.commit(familyId, execId, finalDrafts);
    return {
      invocationId,
      state: outcome,
      output: outcome === 'completed' && result.status === 'ok' ? result.output : undefined,
      ...(error === undefined ? {} : { error }),
    };
  }

  cancel(execId: ExecutionId, invocationId: InvocationId, reason: string): void {
    const familyId = this.mustFamilyId(execId);
    this.commit(familyId, execId, [{ kind: 'invocation.cancel.requested', invocationId, payload: { reason } }]);
  }

  async resolveUncertainty(execId: ExecutionId, invocationId: InvocationId, d: UncertaintyDisposition): Promise<InvocationState> {
    const familyId = this.mustFamilyId(execId);
    const fam = this.family(familyId);
    const inv = fam.executions.get(execId)?.invocations.get(invocationId);
    if (inv === undefined || inv.state !== 'uncertain') throw new S1Error(`invocation ${invocationId} is not uncertain`);
    // Durable world truth constrains which dispositions are even available. If a landing
    // is recorded, "it failed" is not an outcome anyone may assert — the disagreement is
    // about the OUTCOME, and the record is about the WORLD. Compensation is the route for
    // undoing a landed effect; declaring it never happened is not.
    // (docs/20 F-13. The fold refuses this independently, because the fold is the
    // authority and must be correct even against a buggy or hostile writer.)
    if (d.kind === 'abandon-failed' && hasLanded(fam, inv.effectKey)) {
      throw new S1Error(
        `cannot abandon ${invocationId} as failed: effect ${inv.effectKey} has a durable landing`,
      );
    }

    let resolved: InvocationState = 'uncertain';
    let landedNow = false;
    const detail: Record<string, unknown> = { disposition: d.kind };

    switch (d.kind) {
      case 'probe': {
        const provider = this.caps.get(inv.capabilityId);
        if (provider?.probe === undefined) throw new S1Error('capability is not probeable');
        const verdict = await provider.probe(inv.effectKey);
        detail['verdict'] = verdict;
        resolved = verdict === 'landed' ? 'completed' : verdict === 'not-landed' ? 'failed' : 'uncertain';
        landedNow = verdict === 'landed';
        break;
      }
      case 'adopt-landed': resolved = 'completed'; landedNow = true; detail['authority'] = d.authority; break;
      case 'compensate': {
        const provider = this.caps.get(inv.capabilityId);
        if (provider?.compensate === undefined) throw new S1Error('capability is not compensatable');
        const r = await provider.compensate(inv.effectKey);
        detail['compensation'] = r;
        resolved = r === 'compensated' ? 'failed' : 'uncertain';
        break;
      }
      case 'abandon-failed': resolved = 'failed'; detail['authority'] = d.authority; break;
    }

    // Resolving an uncertainty ENDS the invocation, so it must end the lease too. It used
    // to commit one event and touch the ledger not at all, so every resolved uncertainty
    // leaked its reservation permanently: three crash-and-adopt cycles exhausted a
    // three-invocation grant while nothing was running, and the adopted charges settled as
    // having spent nothing (docs/20 F-35, found by adversarial review). S1-I6 caught it —
    // no test had ever called the invariants on this path.
    this.commit(familyId, execId, [
      {
        kind: 'invocation.uncertainty.resolved', invocationId, grantId: inv.grantId,
        payload: { ...detail, resolved, effectKey: inv.effectKey, effectClass: inv.effectClass, landed: landedNow },
      },
      {
        kind: 'grant.settled', invocationId, grantId: inv.grantId,
        // An adopted landing really consumed its reservation; an abandoned or compensated
        // one is charged the invocation only, which is what bounds retry loops.
        payload: {
          units: landedNow || resolved === 'completed' ? inv.reservation : { invocations: 1 },
          releasing: inv.reservation,
        },
      },
    ]);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Commit — the only durable-truth path
  // -------------------------------------------------------------------------

  private commit(familyId: FamilyId, execId: ExecutionId, drafts: readonly Draft[]): void {
    const fam = this.family(familyId);
    const exec = fam.executions.get(execId);
    let seq = exec?.seq ?? 0;
    let prev = exec?.lastHash ?? 'genesis';
    const correlationId = exec?.correlationId ?? execId;
    const events: S1Event[] = [];

    for (const d of drafts) {
      seq += 1;
      const payloadHash = sha(canonical(d.payload));   // B8
      const base = {
        id: this.id('ev'), seq, kind: d.kind, schemaVersion: 1,
        protocolVersion: S1_PROTOCOL_VERSION, executionId: execId, familyId,
        invocationId: d.invocationId, correlationId, causationId: d.causationId,
        actorId: 'kernel', grantId: d.grantId, occurredAt: this.tick(),
        payload: d.payload, payloadHash, artifacts: d.artifacts as never,
      };
      // The chain covers payloadHash, NOT the payload: a redacted payload still verifies.
      const { payload: _omit, ...hashable } = base;
      const self = sha({ ...hashable, prev });
      events.push({ ...base, integrity: { prev, self } } as S1Event);
      prev = self;
    }

    const record = {
      commitToken: this.id('ct'), executionId: execId, familyId, events,
      checksum: '',
    };
    // Checksum covers the WHOLE record (review #2 finding).
    const checksum = sha({ commitToken: record.commitToken, executionId: execId, familyId, events });
    try {
      this.storage.appendCommit({ ...record, checksum });
    } catch (err) {
      if (err instanceof CrashError) throw err;
      // Whether these bytes reached the disk is now UNKNOWN, and the projection below
      // must not advance either way. Wrapping it makes the ambiguity a distinct type the
      // caller cannot mistake for "the capability failed" (docs/20 F-27).
      throw new CommitFailedError(
        `commit ${record.commitToken} for ${execId}: durable outcome unknown (${String(err)})`,
      );
    }

    // Projections advance ONLY through the fold, after the durable write (B4).
    for (const ev of events) foldEvent(fam, ev);
  }

  // -------------------------------------------------------------------------
  // Recovery — same fold, no bespoke reconstruction
  // -------------------------------------------------------------------------

  static recover(
    storage: Storage,
    providers: readonly CapabilityProvider[] = [],
    opts: { quarantine?: boolean } = {},
  ): { kernel: S1Kernel; uncertain: InvocationId[]; quarantined?: string[] } {
    const k = new S1Kernel(storage);
    for (const p of providers) k.register(p);
    const { records, corruptionInMiddle } = storage.readJournal(verifyS1Record);

    // B6: fail closed on mid-journal corruption. A trailing bad record is an interrupted
    // write and discarding it is correct; a bad record with valid records after it is
    // corruption, and folding past it silently deletes history from the middle of the log
    // while everything downstream still looks perfectly consistent. Recovering from that
    // quietly is worse than not recovering, because nobody finds out.
    //
    // `quarantine` is the explicit operator override: recover what is readable, having
    // been told what is being skipped. It is a decision, never a default.
    if (corruptionInMiddle && opts.quarantine !== true) {
      throw new JournalIntegrityError(
        'journal has a non-trailing invalid record; refusing to fold past it. ' +
        'Pass { quarantine: true } to recover the readable prefix deliberately.',
      );
    }

    // INTEGRITY IS VERIFIED WHILE FOLDING, per event.
    //
    // B6's ratified resolution said "verify the chain while folding", and only the
    // record-level checksum had been implemented. The gap was total: `payloadHash` was
    // written on every event and read by nothing outside the test suite, and the record
    // checksum links a record to itself and to nothing before it. So a payload could be
    // rewritten in place with the hash left alone, and whole commit records could be
    // DELETED from the middle of the journal, and recovery accepted both in silence —
    // in the deletion case losing a landing and charging the card again
    // (docs/20 F-31, F-32, found by adversarial review).
    //
    // The chain already carried the evidence. Nothing was reading it.
    const chainTip = new Map<ExecutionId, { seq: number; hash: string }>();
    /** Executions whose chain broke; nothing after the break is verifiable. */
    const stopped = new Set<ExecutionId>();
    const quarantined: string[] = [];

    for (const rec of records) {
      const r = rec as { familyId: FamilyId; events: S1Event[] };
      if (r.familyId === undefined) continue;          // not an S1 record
      let fam = k.families.get(r.familyId);
      if (fam === undefined) { fam = emptyFamily(r.familyId); k.families.set(r.familyId, fam); }
      for (const ev of r.events) {
        // Once an execution's chain is broken, everything after the break is unverifiable
        // — its `prev` links to a hash we can no longer confirm. Under quarantine the
        // recovered state is therefore the PROVABLY INTACT PREFIX, not "everything except
        // the bad record". Folding past a hole is the silent truncation B6 exists to stop.
        if (stopped.has(ev.executionId)) continue;

        const fail = (why: string): void => {
          const e = new JournalIntegrityError(`execution ${ev.executionId}: ${why}`);
          if (opts.quarantine !== true) throw e;
          stopped.add(ev.executionId);
          quarantined.push(e.message);
        };

        const tip = chainTip.get(ev.executionId) ?? { seq: 0, hash: 'genesis' };
        const { payload: _p, integrity, ...rest } = ev as S1Event & Record<string, unknown>;
        const tombstoned = (ev.payload as { redacted?: boolean }).redacted === true;

        if (ev.familyId !== r.familyId) {
          fail(`event ${ev.id} claims family ${String(ev.familyId)} inside a record for ${String(r.familyId)}`);
        } else if (ev.seq !== tip.seq + 1) {
          fail(`seq ${String(ev.seq)} follows ${String(tip.seq)} — a record has been lost, duplicated or reordered`);
        } else if (ev.integrity.prev !== tip.hash) {
          fail(`chain broken at seq ${String(ev.seq)}`);
        } else if (sha({ ...rest, prev: integrity.prev }) !== ev.integrity.self) {
          fail(`self hash mismatch at seq ${String(ev.seq)}`);
        } else if (!tombstoned && sha(canonical(ev.payload)) !== ev.payloadHash) {
          fail(`payload at seq ${String(ev.seq)} does not match its committed hash`);
        }
        if (stopped.has(ev.executionId)) continue;

        chainTip.set(ev.executionId, { seq: ev.seq, hash: ev.integrity.self });

        foldEvent(fam, ev);
        k.familyOf.set(ev.executionId, r.familyId);
        const n = Number(ev.id.split('_')[1] ?? 0);
        if (n > k.counter) k.counter = n;
        if (ev.occurredAt > k.clock) k.clock = ev.occurredAt;
      }
    }

    // Triage: dispatched with no outcome ⇒ the effect may have landed.
    const uncertain: InvocationId[] = [];
    for (const fam of k.families.values()) {
      for (const exec of fam.executions.values()) {
        for (const inv of exec.invocations.values()) {
          if (inv.state !== 'dispatched') continue;
          const claim = fam.claims.get(inv.effectKey);
          const landed = claim?.state === 'landed';
          // EVERY dispatched invocation is triaged, not only the exclusive ones. A
          // non-exclusive invocation left `dispatched` by a crash was unreachable by
          // resume (not suspended), by resolveUncertainty (not uncertain) and by cancel
          // (only read at settlement), so its claim stayed held and its reservation was
          // never released. Five crashes permanently exhausted a five-invocation grant
          // with no reconciliation path (docs/20 F-30, found by adversarial review).
          // A safe class's outcome is unknown too; what differs is that resolving it is
          // cheap, not that it needs no resolution.
          {
            k.commit(fam.familyId, exec.executionId, [{
              kind: 'invocation.uncertain', invocationId: inv.id, grantId: inv.grantId,
              payload: { effectKey: inv.effectKey, effectClass: inv.effectClass, landed,
                descriptor: landed ? 'landed before crash, outcome unrecorded' : 'crash after dispatch' },
            }]);
            uncertain.push(inv.id);
          }
        }
      }
    }
    return { kernel: k, uncertain, ...(quarantined.length > 0 ? { quarantined } : {}) };
  }

  // -------------------------------------------------------------------------
  // Read-only access
  // -------------------------------------------------------------------------

  family(familyId: FamilyId): FamilyProjection {
    const f = this.families.get(familyId);
    if (f === undefined) throw new S1Error(`unknown family ${familyId}`);
    return f;
  }

  familyFor(execId: ExecutionId): FamilyProjection { return this.family(this.mustFamilyId(execId)); }
  familyIds(): FamilyId[] { return [...this.families.keys()]; }
  executionIds(): ExecutionId[] { return [...this.familyOf.keys()]; }
  stagedCount(): number { return this.staged.size; }
  isProtected(execId: ExecutionId, key: EffectKey): boolean {
    return protectionFor(this.familyFor(execId), key).protected;
  }
  remainingFor(execId: ExecutionId, grantId: GrantId, unit: string): number {
    return remaining(this.familyFor(execId), grantId, unit);
  }

  events(familyId: FamilyId): S1Event[] {
    const out: S1Event[] = [];
    for (const rec of this.storage.readJournal(verifyS1Record).records) {
      const r = rec as { familyId?: FamilyId; events: S1Event[] };
      if (r.familyId === familyId) out.push(...r.events);
    }
    return out;
  }

  private mustFamilyId(execId: ExecutionId): FamilyId {
    const f = this.familyOf.get(execId);
    if (f === undefined) throw new S1Error(`unknown execution ${execId}`);
    return f;
  }
}
