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

/** Per-unit reservation: max(capability floor, caller estimate), plus one invocation. */
function reserveUnits(
  policy: Readonly<Record<string, UnitPolicy>> | undefined,
  estimate: Units | undefined,
): Units {
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
    request: unknown,
    grant: GrantHandle,
    opts: S1InvokeOptions = {},
    depth = 0,
  ): Promise<S1Outcome> {
    const familyId = this.mustFamilyId(execId);
    const fam = this.family(familyId);
    const provider = this.caps.get(capabilityId);
    if (provider === undefined) throw new S1Error(`unknown capability ${capabilityId}`);
    this.authorize(fam, grant);

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
      const prot = protectionFor(fam, effectKey);
      if (prot.protected && exclusive) {
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
          payload: { capabilityId, request, effectKey, effectClass, requiresEvidence: opts.requiresEvidence === true } },
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
        const proposal = next.value;
        if (proposal.type === 'external' && proposal.landed) {
          // B3: world truth commits AT YIELD. A later suspension, crash or failure
          // cannot erase it, because it is no longer a candidate.
          //
          // A resumed capability re-runs its body, so it may re-yield a landing that is
          // already recorded. The kernel records that as a duplicate rather than a second
          // landing, which keeps the ledger coherent. It CANNOT undo a real second call to
          // the world — a capability re-entered after suspension is contractually required
          // to consult `ctx.resume` and skip work it already did. That obligation lives in
          // the capability contract, and tests/s1-effects E7 pins the containment.
          this.commit(familyId, execId, [
            hasLanded(this.family(familyId), effectKey)
              ? { kind: 'effect.deduplicated' as const, invocationId, grantId: grant.id,
                  payload: { effectKey, reason: 're-yielded-after-resume', descriptor: proposal.descriptor } }
              : { kind: 'effect.landed' as const, invocationId, grantId: grant.id,
                  payload: { effectKey, effectClass, descriptor: proposal.descriptor } },
          ]);
          next = await gen.next(undefined);
          continue;
        }
        if (proposal.type === 'delegate') {
          const outcome = await this.delegate(familyId, execId, grant, proposal, a.depth, invocationId);
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
      return this.settle(familyId, execId, invocationId, grant.id, effectKey, effectClass, reservation,
        { status: 'failed', error: String(err) });
    }

    return this.settle(familyId, execId, invocationId, grant.id, effectKey, effectClass, reservation, result);
  }

  private async delegate(
    familyId: FamilyId, execId: ExecutionId, parentHandle: GrantHandle,
    proposal: Extract<EffectProposal, { type: 'delegate' }>, depth: number, parentInvocation: InvocationId,
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
      const out = await this.invoke(execId, proposal.capabilityId, proposal.request, child,
        { step: proposal.step ?? `delegate:${parentInvocation}` }, depth + 1);
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

    if (result.status === 'ok') {
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
            for (const [u, v] of Object.entries(p.units)) usage[u] = (usage[u] ?? 0) + v;
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
    const units = this.caps.get(inv?.capabilityId ?? '')?.manifest.units;
    const cappedUsage: Record<string, number> = {};
    for (const [unit, held] of Object.entries(reservation)) {
      const declared = usage[unit];
      const metered = unit === 'invocations' ? true : units?.[unit]?.metered === true;
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
      // Declared against a unit nobody reserved: unauthorized, so it settles at nothing
      // and is recorded. The capability's manifest should have declared the unit.
      drafts.push({ kind: 'policy.denied', invocationId, grantId,
        payload: { reason: 'usage-in-unreserved-unit', unit, declared } });
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
      finalDrafts.push({ kind: 'effect.released', invocationId, grantId, payload: { effectKey } });
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

    this.commit(familyId, execId, [{
      kind: 'invocation.uncertainty.resolved', invocationId, grantId: inv.grantId,
      payload: { ...detail, resolved, effectKey: inv.effectKey, effectClass: inv.effectClass, landed: landedNow },
    }]);
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
    this.storage.appendCommit({ ...record, checksum });

    // Projections advance ONLY through the fold, after the durable write (B4).
    for (const ev of events) foldEvent(fam, ev);
  }

  // -------------------------------------------------------------------------
  // Recovery — same fold, no bespoke reconstruction
  // -------------------------------------------------------------------------

  static recover(storage: Storage, providers: readonly CapabilityProvider[] = []): { kernel: S1Kernel; uncertain: InvocationId[] } {
    const k = new S1Kernel(storage);
    for (const p of providers) k.register(p);
    const { records } = storage.readJournal(verifyS1Record);

    for (const rec of records) {
      const r = rec as { familyId: FamilyId; events: S1Event[] };
      if (r.familyId === undefined) continue;          // not an S1 record
      let fam = k.families.get(r.familyId);
      if (fam === undefined) { fam = emptyFamily(r.familyId); k.families.set(r.familyId, fam); }
      for (const ev of r.events) {
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
          if (landed || requiresExclusiveClaim(inv.effectClass)) {
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
    return { kernel: k, uncertain };
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
