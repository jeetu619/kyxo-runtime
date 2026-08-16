/**
 * The Kyxo semantic kernel.
 *
 * Executable form of docs/17-KERNEL-SEMANTICS.md. Design rules enforced here:
 *
 *  1. Capabilities are PURE PROPOSERS. They receive data, yield EffectProposals, and
 *     return an outcome. They hold no kernel reference, so no userland component can
 *     append to the journal, mint authority, or promote an artifact. The commit
 *     barrier is structural, not cooperative.
 *  2. The kernel branches on DECLARED, NEGOTIATED PROPERTIES (effect class, traits) —
 *     never on what kind of thing a capability is.
 *  3. resume() continues a lineage (fold snapshot + committed suffix).
 *     fork() branches a lineage (fold to the cut ONLY). This is the resolution of the
 *     phase-1 checkpoint/journal incoherence.
 *  4. Uncertainty is represented, never guessed.
 */

import {
  type ArtifactRef,
  type Checkpoint,
  type CheckpointId,
  type CapabilityProvider,
  type EffectClass,
  type EffectKey,
  type EffectProposal,
  type EventId,
  type EventKind,
  type ExecutionId,
  type ForkOptions,
  type GrantId,
  type GrantState,
  type InvocationId,
  type InvocationRecord,
  type InvocationState,
  type KernelEvent,
  type PendingInvocation,
  type PolicyStage,
  type UncertaintyDisposition,
  GrantHandle,
  PROTOCOL_VERSION,
  UNSAFE_TO_AUTO_RETRY,
  EXTERNAL_CLASSES,
} from './types.ts';
import { CrashError, Storage, canonical, sha } from './storage.ts';

export class KernelError extends Error {}
export class AuthorizationError extends KernelError {}
export class BudgetError extends KernelError {}
export class ForkError extends KernelError {}
export class CommitBarrierError extends KernelError {}

interface DraftEvent {
  readonly kind: EventKind;
  readonly invocationId?: InvocationId | undefined;
  readonly causationId?: EventId | undefined;
  readonly actorId: string;
  readonly grantId?: GrantId | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
}

interface EffectIndexEntry {
  readonly invocationId: InvocationId;
  readonly effectClass: EffectClass;
  readonly landed: boolean;
  readonly outcome: 'completed' | 'failed' | 'uncertain';
  /**
   * True when this entry was inherited across a fork rather than produced by this
   * lineage. Falsified by tests/fork.test.ts: without this distinction an inherited
   * irreversible effect is absorbed as a silent cache hit, which is indistinguishable
   * from "we performed it" to the caller. See docs/20 F-1.
   */
  readonly inherited?: boolean;
}

export interface ExecutionState {
  executionId: ExecutionId;
  correlationId: string;
  seq: number;
  lastHash: string;
  definitionHash: string;
  parent?: { executionId: ExecutionId; checkpointId: CheckpointId; cutSeq: number } | undefined;
  invocations: Map<InvocationId, InvocationRecord>;
  cell: Map<string, unknown>;
  artifacts: ArtifactRef[];
  /** Replay cache: effect identity → what happened. Lineage-scoped by construction. */
  effectIndex: Map<EffectKey, EffectIndexEntry>;
  /** Bounded reliability window for delivery/commit dedup (A11: distinct mechanism). */
  dedupWindow: Set<EffectKey>;
  /** Landed irreversible effects: a fork may never silently redo these. */
  protectedEffects: Set<EffectKey>;
  grants: Map<GrantId, GrantState>;
  cancelRequested: Set<InvocationId>;
  evidence: Map<InvocationId, 'pass' | 'fail'>;
}

export interface InvokeOptions {
  /** Caller-supplied step identity; folded into the content-inclusive effect key. */
  readonly step?: string;
  /** Commit gate: outcome cannot be `completed` without a passing evidence proposal. */
  readonly requiresEvidence?: boolean;
  /** Simulated duplicate delivery of an identical request (tests delivery dedup). */
  readonly duplicateDelivery?: boolean;
  readonly effectClassOverride?: EffectClass;
}

export interface InvokeOutcome {
  readonly invocationId: InvocationId;
  readonly state: InvocationState;
  readonly output?: unknown;
  readonly error?: string;
  readonly deduplicated?: boolean;
}

export class Kernel {
  private readonly storage: Storage;
  private readonly caps = new Map<string, CapabilityProvider>();
  private readonly policies: PolicyStage[] = [];
  private readonly executions = new Map<ExecutionId, ExecutionState>();
  private readonly checkpoints = new Map<CheckpointId, Checkpoint>();
  /** The kernel's private registry of handles it minted. Identity IS authority (A8). */
  private readonly mintedHandles = new WeakSet<GrantHandle>();
  /** Staging area. NEVER durable — a crash here loses candidates by construction (I16). */
  private readonly staged = new Map<InvocationId, EffectProposal[]>();
  private counter = 0;
  private logicalClock = 0;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  register(provider: CapabilityProvider): void {
    this.caps.set(provider.manifest.id, provider);
  }

  addPolicy(stage: PolicyStage): void {
    this.policies.push(stage);
  }

  tick(n = 1): number {
    this.logicalClock += n;
    return this.logicalClock;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(6, '0')}`;
  }

  // -------------------------------------------------------------------------
  // Executions and grants
  // -------------------------------------------------------------------------

  createExecution(opts?: { correlationId?: string; definitionHash?: string }): ExecutionId {
    const id = this.nextId('exec') as ExecutionId;
    const state: ExecutionState = {
      executionId: id,
      correlationId: opts?.correlationId ?? id,
      seq: 0,
      lastHash: 'genesis',
      definitionHash: opts?.definitionHash ?? 'D1',
      invocations: new Map(),
      cell: new Map(),
      artifacts: [],
      effectIndex: new Map(),
      dedupWindow: new Set(),
      protectedEffects: new Set(),
      grants: new Map(),
      cancelRequested: new Set(),
      evidence: new Map(),
    };
    this.executions.set(id, state);
    this.commit(state, [
      {
        kind: 'execution.created',
        actorId: 'kernel',
        payload: { correlationId: state.correlationId, definitionHash: state.definitionHash },
      },
    ]);
    return id;
  }

  issueGrant(
    executionId: ExecutionId,
    spec: { rights: readonly string[]; limits: Record<string, number>; expiresAt?: number },
  ): GrantHandle {
    const exec = this.mustExec(executionId);
    const id = this.nextId('grant') as GrantId;
    const state: GrantState = {
      id,
      rights: [...spec.rights],
      limits: { ...spec.limits },
      reserved: {},
      settled: {},
      revoked: false,
      expiresAt: spec.expiresAt,
    };
    exec.grants.set(id, state);
    this.commit(exec, [
      { kind: 'grant.issued', actorId: 'kernel', grantId: id, payload: { rights: state.rights, limits: state.limits } },
    ]);
    return this.mint(id);
  }

  /** Attenuation: child ≤ parent on every dimension. Widening is impossible (I5, I18). */
  attenuate(
    executionId: ExecutionId,
    parent: GrantHandle,
    spec: { rights: readonly string[]; limits: Record<string, number> },
  ): GrantHandle {
    const exec = this.mustExec(executionId);
    const p = this.authorize(exec, parent);
    for (const r of spec.rights) {
      if (!p.rights.includes(r)) throw new AuthorizationError(`attenuation cannot add right: ${r}`);
    }
    for (const [unit, amount] of Object.entries(spec.limits)) {
      const parentRemaining = this.remaining(p, unit);
      if (amount > parentRemaining) {
        throw new AuthorizationError(`attenuation cannot exceed parent remaining ${unit}: ${amount} > ${parentRemaining}`);
      }
    }
    const id = this.nextId('grant') as GrantId;
    const child: GrantState = {
      id,
      parent: p.id,
      rights: [...spec.rights],
      limits: { ...spec.limits },
      reserved: {},
      settled: {},
      revoked: false,
      expiresAt: p.expiresAt,
    };
    exec.grants.set(id, child);
    this.commit(exec, [
      { kind: 'grant.attenuated', actorId: 'kernel', grantId: id, payload: { parent: p.id, rights: child.rights, limits: child.limits } },
    ]);
    return this.mint(id);
  }

  /** Mint a handle and record it in the kernel-private registry. */
  private mint(id: GrantId): GrantHandle {
    const h = new GrantHandle(id);
    this.mintedHandles.add(h);
    return h;
  }

  /** Transitive revocation over the grant lineage. */
  revoke(executionId: ExecutionId, handle: GrantHandle): void {
    const exec = this.mustExec(executionId);
    const g = this.authorize(exec, handle);
    const drafts: DraftEvent[] = [];
    const walk = (id: GrantId): void => {
      const st = exec.grants.get(id);
      if (!st || st.revoked) return;
      exec.grants.set(id, { ...st, revoked: true });
      drafts.push({ kind: 'grant.revoked', actorId: 'kernel', grantId: id, payload: { transitive: id !== g.id } });
      for (const [cid, c] of exec.grants) if (c.parent === id) walk(cid);
    };
    walk(g.id);
    if (drafts.length > 0) this.commit(exec, drafts);
  }

  private authorize(exec: ExecutionState, handle: GrantHandle): GrantState {
    // Handle-shaped authority (A8): only an object this kernel minted is authority.
    // Knowing the id string is NOT sufficient — this is the ocap discipline.
    if (!this.mintedHandles.has(handle)) {
      throw new AuthorizationError(`invalid grant handle: ${String((handle as { id?: string }).id)}`);
    }
    const st = exec.grants.get(handle.id);
    if (st === undefined) throw new AuthorizationError(`grant not in execution: ${handle.id}`);
    return st;
  }

  private remaining(g: GrantState, unit: string): number {
    const limit = g.limits[unit];
    if (limit === undefined) return 0;
    return limit - (g.reserved[unit] ?? 0) - (g.settled[unit] ?? 0);
  }

  private chain(exec: ExecutionState, id: GrantId): GrantState[] {
    const out: GrantState[] = [];
    let cur: GrantId | undefined = id;
    while (cur !== undefined) {
      const st: GrantState | undefined = exec.grants.get(cur);
      if (st === undefined) break;
      out.push(st);
      cur = st.parent;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Invocation — the two-phase lifecycle
  // -------------------------------------------------------------------------

  async invoke(
    executionId: ExecutionId,
    capabilityId: string,
    request: unknown,
    grant: GrantHandle,
    opts: InvokeOptions = {},
    depth = 0,
  ): Promise<InvokeOutcome> {
    const exec = this.mustExec(executionId);
    const provider = this.caps.get(capabilityId);
    if (provider === undefined) throw new KernelError(`unknown capability: ${capabilityId}`);

    const grantState = this.authorize(exec, grant);
    const effectClass = opts.effectClassOverride ?? provider.manifest.traits.effectClass;

    // Effect identity is content-inclusive (A1): same step + different args ⇒ different key.
    const effectKey = sha({
      cap: capabilityId,
      step: opts.step ?? 'anon',
      request,
    }) as EffectKey;

    // --- Inherited irreversible effects refuse LOUDLY; they are not cache hits. ---
    // An effect this lineage performed may be deduplicated silently (a retry is safe).
    // An effect an ANCESTOR performed before the cut must not be reported as this
    // lineage's success, because the caller cannot tell a replay from a real charge.
    const priorEntry = exec.effectIndex.get(effectKey);
    if (
      exec.protectedEffects.has(effectKey) ||
      (priorEntry?.inherited === true && UNSAFE_TO_AUTO_RETRY.has(priorEntry.effectClass))
    ) {
      this.commit(exec, [
        {
          kind: 'policy.denied',
          actorId: 'kernel',
          grantId: grantState.id,
          payload: { effectKey, reason: 'protected-irreversible-replay', inherited: priorEntry?.inherited === true },
        },
      ]);
      throw new ForkError(`refusing to replay protected irreversible effect ${effectKey}`);
    }

    // --- Duplicate delivery: suppress the effect, PRESERVE the evidence (I14) ---
    const prior = priorEntry;
    if (prior !== undefined) {
      this.commit(exec, [
        {
          kind: opts.duplicateDelivery ? 'delivery.duplicate' : 'effect.deduplicated',
          actorId: 'kernel',
          invocationId: prior.invocationId,
          grantId: grantState.id,
          payload: { effectKey, originalInvocation: prior.invocationId, outcome: prior.outcome },
        },
      ]);
      return { invocationId: prior.invocationId, state: prior.outcome === 'uncertain' ? 'uncertain' : (prior.outcome as InvocationState), deduplicated: true };
    }

    // --- Admission: authority, policy, reservation (all before dispatch) ---
    const invocationId = this.nextId('inv') as InvocationId;
    for (const g of this.chain(exec, grantState.id)) {
      if (g.revoked) {
        this.commit(exec, [{ kind: 'grant.denied', actorId: 'kernel', grantId: g.id, payload: { invocationId, reason: 'revoked' } }]);
        throw new AuthorizationError(`grant revoked: ${g.id}`);
      }
      if (g.expiresAt !== undefined && this.logicalClock > g.expiresAt) {
        this.commit(exec, [{ kind: 'grant.denied', actorId: 'kernel', grantId: g.id, payload: { invocationId, reason: 'expired' } }]);
        throw new AuthorizationError(`grant expired: ${g.id}`);
      }
    }
    for (const stage of this.policies) {
      const d = stage.evaluate({ capabilityId, effectClass, grant: grantState, phase: 'admission' });
      if (d.decision === 'deny') {
        this.commit(exec, [{ kind: 'policy.denied', actorId: 'kernel', grantId: grantState.id, payload: { invocationId, stage: stage.name, reason: d.reason } }]);
        throw new AuthorizationError(`policy denied at admission: ${d.reason}`);
      }
    }

    // Reservation (A2): durable BEFORE dispatch, so a crash cannot lose the hold.
    const reservation = { invocations: 1 };
    for (const g of this.chain(exec, grantState.id)) {
      if (this.remaining(g, 'invocations') < 1) {
        this.commit(exec, [{ kind: 'grant.denied', actorId: 'kernel', grantId: g.id, payload: { invocationId, reason: 'budget-exhausted' } }]);
        throw new BudgetError(`budget exhausted on ${g.id}`);
      }
    }

    this.commit(exec, [
      {
        kind: 'invocation.admitted',
        actorId: 'kernel',
        invocationId,
        grantId: grantState.id,
        payload: { capabilityId, effectKey, effectClass, requiresEvidence: opts.requiresEvidence === true },
      },
      { kind: 'grant.reserved', actorId: 'kernel', invocationId, grantId: grantState.id, payload: { units: reservation } },
    ]);

    // --- Dispatch: the intent record makes post-crash uncertainty detectable ---
    this.commit(exec, [
      {
        kind: 'invocation.dispatched',
        actorId: 'kernel',
        invocationId,
        grantId: grantState.id,
        payload: { effectKey, effectClass, leaseEpoch: 1, external: EXTERNAL_CLASSES.has(effectClass) },
      },
    ]);

    // --- Execute. Proposals go to STAGING, never to the journal. ---
    this.staged.set(invocationId, []);
    const ctx = {
      invocationId,
      executionId,
      now: this.tick(),
      attempt: 1,
      request,
      cancelled: () => exec.cancelRequested.has(invocationId),
    };

    let result: { status: 'ok'; output: unknown } | { status: 'failed'; error: string } | { status: 'suspend'; reason: string; payload: unknown };
    try {
      const gen = provider.invoke(ctx);
      let next = await gen.next();
      while (!next.done) {
        const proposal = next.value;
        if (proposal.type === 'delegate') {
          // Kernel-mediated delegation: the child runs under an ATTENUATED grant, so a
          // capability can never widen authority by delegating (I5/I18), and every
          // child effect is journaled like any other invocation.
          const outcome = await this.delegate(exec, grant, grantState, proposal, depth, invocationId);
          next = await gen.next(outcome);
          continue;
        }
        this.staged.get(invocationId)!.push(proposal);
        next = await gen.next(undefined);
      }
      result = next.value;
    } catch (err) {
      // Staging must be released on EVERY exit path. A provider that throws a
      // crash-class error without killing the process would otherwise leave its
      // candidate effects resident in a live kernel.
      // (Falsified by tests/coverage.test.ts seed=8 op#24 — see docs/20 F-5.)
      this.staged.delete(invocationId);
      if (err instanceof CrashError) throw err;
      return this.settleFailure(exec, invocationId, grantState.id, effectKey, effectClass, String(err));
    }

    return this.settle(exec, invocationId, grantState.id, effectKey, effectClass, capabilityId, result, opts);
  }

  /**
   * Execute a delegate proposal. The child grant is attenuated from the parent's
   * REMAINING budget and its spawn depth is decremented, so recursion is bounded by
   * authority rather than by a global counter.
   */
  private async delegate(
    exec: ExecutionState,
    parentHandle: GrantHandle,
    parentState: GrantState,
    proposal: Extract<EffectProposal, { type: 'delegate' }>,
    depth: number,
    parentInvocation: InvocationId,
  ): Promise<{ state: InvocationState; output?: unknown; error?: string | undefined }> {
    // Authority MUST be read fresh: the captured state predates this invocation's own
    // reservation, and computing a child budget from it overshoots the true remaining.
    // (Falsified by tests/grants.test.ts recursion case — see docs/20 F-3.)
    const current = exec.grants.get(parentState.id) ?? parentState;
    const allowedDepth = current.limits['spawnDepth'] ?? 0;
    if (depth + 1 > allowedDepth) {
      this.commit(exec, [
        {
          kind: 'policy.denied',
          actorId: 'kernel',
          invocationId: parentInvocation,
          grantId: parentState.id,
          payload: { reason: 'spawn-depth-exceeded', depth: depth + 1, allowed: allowedDepth },
        },
      ]);
      return { state: 'failed', error: 'spawn-depth-exceeded' };
    }

    let childHandle: GrantHandle;
    try {
      childHandle = this.attenuate(exec.executionId, parentHandle, {
        rights: current.rights,
        limits: {
          invocations: Math.max(0, Math.min(this.remaining(current, 'invocations'), 4)),
          spawnDepth: allowedDepth - 1,
        },
      });
    } catch (err) {
      // A delegation refused for lack of authority is a policy outcome, not a silent
      // failure: it must appear on the truth plane like every other denial.
      this.commit(exec, [
        {
          kind: 'policy.denied',
          actorId: 'kernel',
          invocationId: parentInvocation,
          grantId: current.id,
          payload: { reason: 'delegation-attenuation-refused', detail: String(err) },
        },
      ]);
      return { state: 'failed', error: String(err) };
    }

    try {
      const out = await this.invoke(
        exec.executionId,
        proposal.capabilityId,
        proposal.request,
        childHandle,
        { step: proposal.step ?? `delegate:${parentInvocation}` },
        depth + 1,
      );
      return { state: out.state, output: out.output, error: out.error };
    } catch (err) {
      if (err instanceof CrashError) throw err;
      return { state: 'failed', error: String(err) };
    }
  }

  /** Validate staged proposals and commit them atomically, or reject them entirely. */
  private settle(
    exec: ExecutionState,
    invocationId: InvocationId,
    grantId: GrantId,
    effectKey: EffectKey,
    effectClass: EffectClass,
    capabilityId: string,
    result: { status: 'ok'; output: unknown } | { status: 'failed'; error: string } | { status: 'suspend'; reason: string; payload: unknown },
    opts: InvokeOptions,
  ): InvokeOutcome {
    const proposals = this.staged.get(invocationId) ?? [];
    this.staged.delete(invocationId);

    const landedExternal = proposals.some((p) => p.type === 'external' && p.landed);

    if (result.status === 'suspend') {
      this.commit(exec, [
        { kind: 'invocation.suspended', actorId: 'kernel', invocationId, grantId, payload: { reason: result.reason, payload: result.payload, origin: 'provider' } },
      ]);
      return { invocationId, state: 'suspended' };
    }

    if (result.status === 'failed') {
      return this.settleFailure(exec, invocationId, grantId, effectKey, effectClass, result.error, landedExternal);
    }

    // Cancellation observed during execution.
    if (exec.cancelRequested.has(invocationId)) {
      this.commit(exec, [
        { kind: 'invocation.canceled', actorId: 'kernel', invocationId, grantId, payload: { effectKey, effectClass, landedExternal } },
        { kind: 'grant.released', actorId: 'kernel', invocationId, grantId, payload: { units: { invocations: 1 } } },
      ]);
      exec.effectIndex.set(effectKey, { invocationId, effectClass, landed: landedExternal, outcome: 'failed' });
      return { invocationId, state: 'canceled' };
    }

    // Authority re-check at commit (time-of-use, catches mid-flight revocation).
    const revoked = this.chain(exec, grantId).find((g) => g.revoked);
    if (revoked !== undefined) {
      // The world-effect record is truth and must be journaled even though the
      // outcome is denied; artifacts are NOT promoted, so no benefit is conferred.
      this.commit(exec, [
        { kind: 'grant.denied', actorId: 'kernel', invocationId, grantId: revoked.id, payload: { phase: 'commit', reason: 'revoked-mid-flight', landedExternal, effectKey } },
        { kind: 'invocation.failed', actorId: 'kernel', invocationId, grantId, payload: { error: 'authorization-revoked-post-hoc', landedExternal, effectKey } },
        { kind: 'grant.released', actorId: 'kernel', invocationId, grantId, payload: { units: { invocations: 1 } } },
      ]);
      exec.effectIndex.set(effectKey, { invocationId, effectClass, landed: landedExternal, outcome: 'failed' });
      return { invocationId, state: 'failed', error: 'authorization-revoked-post-hoc' };
    }

    // Commit-phase policy stages see the actual proposals.
    for (const stage of this.policies) {
      const d = stage.evaluate({ capabilityId, effectClass, grant: exec.grants.get(grantId)!, phase: 'commit', proposals });
      if (d.decision === 'deny') {
        this.commit(exec, [
          { kind: 'policy.denied', actorId: 'kernel', invocationId, grantId, payload: { stage: stage.name, reason: d.reason, phase: 'commit' } },
          { kind: 'invocation.failed', actorId: 'kernel', invocationId, grantId, payload: { error: `policy: ${d.reason}`, effectKey, effectClass, landedExternal } },
          { kind: 'grant.released', actorId: 'kernel', invocationId, grantId, payload: { units: { invocations: 1 } } },
        ]);
        exec.effectIndex.set(effectKey, { invocationId, effectClass, landed: landedExternal, outcome: 'failed' });
        return { invocationId, state: 'failed', error: `policy: ${d.reason}` };
      }
    }

    // THE COMMIT GATE (I17). Structural: the capability cannot bypass it because it
    // cannot write to the journal at all. Failing verification cannot present as success.
    const evidence = proposals.filter((p): p is Extract<EffectProposal, { type: 'evidence' }> => p.type === 'evidence');
    if (opts.requiresEvidence === true) {
      const passed = evidence.some((e) => e.verdict === 'pass');
      if (!passed) {
        const drafts: DraftEvent[] = evidence.map((e) => ({
          kind: 'evidence.produced' as EventKind,
          actorId: 'kernel',
          invocationId,
          grantId,
          payload: { verdict: e.verdict, detail: e.detail },
        }));
        drafts.push(
          { kind: 'invocation.failed', actorId: 'kernel', invocationId, grantId, payload: { error: 'verification-failed', evidenceCount: evidence.length, effectKey, effectClass, landedExternal } },
          { kind: 'grant.released', actorId: 'kernel', invocationId, grantId, payload: { units: { invocations: 1 } } },
        );
        this.commit(exec, drafts);
        exec.effectIndex.set(effectKey, { invocationId, effectClass, landed: landedExternal, outcome: 'failed' });
        exec.evidence.set(invocationId, 'fail');
        return { invocationId, state: 'failed', error: 'verification-failed' };
      }
    }

    // Promote staged proposals into durable truth — one atomic commit record.
    const drafts: DraftEvent[] = [];
    const usage: Record<string, number> = {};
    for (const p of proposals) {
      switch (p.type) {
        case 'artifact': {
          // CAS dedups BYTES; the journal always records THIS invocation's production
          // with its own provenance (I14 — the phase-1 bug this replaces).
          const ref = this.storage.putBlob(p.content) as ArtifactRef;
          exec.artifacts.push(ref);
          drafts.push({
            kind: 'artifact.produced',
            actorId: 'kernel',
            invocationId,
            grantId,
            artifacts: [ref],
            payload: { ref, labels: p.labels ?? [], producedBy: invocationId },
          });
          break;
        }
        case 'state':
          exec.cell.set(p.key, p.value);
          drafts.push({ kind: 'state.updated', actorId: 'kernel', invocationId, grantId, payload: { key: p.key, value: p.value } });
          break;
        case 'usage':
          for (const [u, v] of Object.entries(p.units)) usage[u] = (usage[u] ?? 0) + v;
          break;
        case 'evidence':
          exec.evidence.set(invocationId, p.verdict);
          drafts.push({ kind: 'evidence.produced', actorId: 'kernel', invocationId, grantId, payload: { verdict: p.verdict, detail: p.detail } });
          break;
        case 'external':
          if (p.landed && effectClass === 'external-irreversible') exec.protectedEffects.add(effectKey);
          break;
        case 'progress':
          // Advisory plane only: never committed. Deliberately dropped here.
          break;
      }
    }

    usage['invocations'] = 1;
    drafts.push(
      { kind: 'invocation.completed', actorId: 'kernel', invocationId, grantId, payload: { effectKey, effectClass, output: result.output, landedExternal } },
      { kind: 'grant.settled', actorId: 'kernel', invocationId, grantId, payload: { units: usage } },
    );
    this.commit(exec, drafts);
    exec.effectIndex.set(effectKey, { invocationId, effectClass, landed: landedExternal, outcome: 'completed' });
    exec.dedupWindow.add(effectKey);
    return { invocationId, state: 'completed', output: result.output };
  }

  private settleFailure(
    exec: ExecutionState,
    invocationId: InvocationId,
    grantId: GrantId,
    effectKey: EffectKey,
    effectClass: EffectClass,
    error: string,
    landedExternal = false,
  ): InvokeOutcome {
    this.commit(exec, [
      { kind: 'invocation.failed', actorId: 'kernel', invocationId, grantId, payload: { error, effectKey, effectClass, landedExternal } },
      { kind: 'grant.released', actorId: 'kernel', invocationId, grantId, payload: { units: { invocations: 1 } } },
    ]);
    exec.effectIndex.set(effectKey, { invocationId, effectClass, landed: landedExternal, outcome: 'failed' });
    return { invocationId, state: 'failed', error };
  }

  /** Cancellation REQUESTS are journaled, not only honored transitions (A10). */
  cancel(executionId: ExecutionId, invocationId: InvocationId, reason: string): void {
    const exec = this.mustExec(executionId);
    exec.cancelRequested.add(invocationId);
    this.commit(exec, [
      { kind: 'invocation.cancel.requested', actorId: 'kernel', invocationId, payload: { reason } },
    ]);
  }

  /**
   * Re-enter a suspended invocation with a typed payload. The provider is re-invoked
   * (it cannot hold a serialized continuation), which is why `resumable` capabilities
   * MUST be able to reconstruct from the suspension payload alone.
   */
  async resumeInvocation(
    executionId: ExecutionId,
    invocationId: InvocationId,
    payload: unknown,
    grant: GrantHandle,
  ): Promise<InvokeOutcome> {
    const exec = this.mustExec(executionId);
    const inv = exec.invocations.get(invocationId);
    if (inv === undefined || inv.state !== 'suspended') throw new KernelError(`invocation ${invocationId} is not suspended`);
    const provider = this.caps.get(inv.capabilityId);
    if (provider === undefined) throw new KernelError(`unknown capability: ${inv.capabilityId}`);
    const grantState = this.authorize(exec, grant);

    this.commit(exec, [
      { kind: 'invocation.resumed', actorId: 'kernel', invocationId, grantId: grantState.id, payload: { origin: 'provider' } },
    ]);

    this.staged.set(invocationId, []);
    const ctx = {
      invocationId,
      executionId,
      now: this.tick(),
      attempt: inv.attempt + 1,
      request: inv.suspension?.payload,
      resume: { payload },
      cancelled: () => exec.cancelRequested.has(invocationId),
    };
    const gen = provider.invoke(ctx);
    let next = await gen.next();
    while (!next.done) {
      this.staged.get(invocationId)!.push(next.value);
      next = await gen.next(undefined);
    }
    return this.settle(exec, invocationId, grantState.id, inv.effectKey, inv.effectClass, inv.capabilityId, next.value, {});
  }

  /**
   * resume(checkpoint) — CONTINUE the same lineage.
   *
   * Distinct from fork: resume keeps the execution identity and folds the committed
   * suffix after the cut. The checkpoint is an accelerator, not a rewind. Verifying
   * that snapshot-fold equals journal-fold at the cut is invariant I20.
   */
  resumeFromCheckpoint(checkpointId: CheckpointId): { executionId: ExecutionId; consistent: boolean; pending: readonly PendingInvocation[] } {
    const cp = this.checkpoints.get(checkpointId) ?? (this.storage.getCheckpoint(checkpointId) as Checkpoint | undefined);
    if (cp === undefined) throw new KernelError(`unknown checkpoint: ${checkpointId}`);
    const exec = this.mustExec(cp.executionId);
    if (cp.cutSeq > exec.seq) {
      return { executionId: cp.executionId, consistent: false, pending: cp.pending };
    }
    // Determinism check: rebuild state from the journal prefix and compare with the snapshot.
    const snap = this.storage.getBlob(cp.stateSnapshot) as { cell: [string, unknown][] };
    const rebuilt = new Map<string, unknown>();
    for (const rec of this.storage.readJournal().records) {
      const r = rec as { executionId: ExecutionId; events: KernelEvent[] };
      if (r.executionId !== cp.executionId) continue;
      for (const ev of r.events) {
        if (ev.seq > cp.cutSeq) break;
        if (ev.kind === 'state.updated') rebuilt.set(ev.payload['key'] as string, ev.payload['value']);
      }
    }
    const consistent = canonical([...rebuilt.entries()].sort()) === canonical([...snap.cell].sort());
    return { executionId: cp.executionId, consistent, pending: cp.pending };
  }

  // -------------------------------------------------------------------------
  // Uncertainty
  // -------------------------------------------------------------------------

  async resolveUncertainty(
    executionId: ExecutionId,
    invocationId: InvocationId,
    disposition: UncertaintyDisposition,
  ): Promise<InvocationState> {
    const exec = this.mustExec(executionId);
    const inv = exec.invocations.get(invocationId);
    if (inv === undefined || inv.state !== 'uncertain') {
      throw new KernelError(`invocation ${invocationId} is not uncertain`);
    }
    let resolved: InvocationState;
    let detail: Record<string, unknown> = {};

    switch (disposition.kind) {
      case 'probe': {
        const provider = this.caps.get(inv.capabilityId);
        if (provider?.probe === undefined) throw new KernelError('capability is not probeable');
        const verdict = await provider.probe(inv.effectKey);
        detail = { verdict };
        resolved = verdict === 'landed' ? 'completed' : verdict === 'not-landed' ? 'failed' : 'uncertain';
        break;
      }
      case 'adopt-landed':
        detail = { authority: disposition.authority };
        resolved = 'completed';
        break;
      case 'compensate': {
        const provider = this.caps.get(inv.capabilityId);
        if (provider?.compensate === undefined) throw new KernelError('capability is not compensatable');
        const r = await provider.compensate(inv.effectKey);
        detail = { compensation: r };
        resolved = r === 'compensated' ? 'failed' : 'uncertain';
        break;
      }
      case 'abandon-failed':
        detail = { authority: disposition.authority };
        resolved = 'failed';
        break;
    }

    this.commit(exec, [
      {
        kind: 'invocation.uncertainty.resolved',
        actorId: 'kernel',
        invocationId,
        grantId: inv.grantId,
        payload: { disposition: disposition.kind, resolved, ...detail },
      },
      ...(resolved === 'uncertain'
        ? []
        : [{
            kind: (resolved === 'completed' ? 'invocation.completed' : 'invocation.failed') as EventKind,
            actorId: 'kernel',
            invocationId,
            grantId: inv.grantId,
            payload: { effectKey: inv.effectKey, resolvedFromUncertainty: true },
          }]),
    ]);
    if (resolved === 'completed' && inv.effectClass === 'external-irreversible') {
      exec.protectedEffects.add(inv.effectKey);
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Checkpoint / resume / fork
  // -------------------------------------------------------------------------

  checkpoint(executionId: ExecutionId): Checkpoint {
    const exec = this.mustExec(executionId);
    const snapshot = this.storage.putBlob({
      cell: [...exec.cell.entries()],
      artifacts: exec.artifacts,
      effectIndex: [...exec.effectIndex.entries()],
      evidence: [...exec.evidence.entries()],
    }) as ArtifactRef;

    const pending: PendingInvocation[] = [...exec.invocations.values()]
      .filter((i) => i.state === 'dispatched' || i.state === 'uncertain' || i.state === 'suspended')
      .map((i) => ({ id: i.id, effectKey: i.effectKey, effectClass: i.effectClass, leaseEpoch: i.leaseEpoch, state: i.state }));

    const cp: Checkpoint = {
      id: this.nextId('ck') as CheckpointId,
      executionId,
      cutSeq: exec.seq,
      stateSnapshot: snapshot,
      pending,
      dedupWindow: [...exec.dedupWindow],
      protectedEffects: [...exec.protectedEffects],
      grants: [...exec.grants.values()],
      definitionHash: exec.definitionHash,
      protocolVersion: PROTOCOL_VERSION,
    };
    this.storage.putCheckpoint(cp.id, cp);
    this.checkpoints.set(cp.id, cp);
    this.commit(exec, [
      { kind: 'checkpoint.cut', actorId: 'kernel', payload: { checkpointId: cp.id, cutSeq: cp.cutSeq, pending: pending.length } },
    ]);
    return cp;
  }

  /**
   * fork(checkpoint) — branch a NEW lineage from a cut.
   *
   * The child folds the parent journal ONLY up to cutSeq. Post-cut parent events are
   * not inherited, so the child's effect index cannot contain outcomes the parent
   * produced after the cut. This is the resolution of the phase-1 incoherence.
   */
  fork(checkpointId: CheckpointId, opts: ForkOptions): ExecutionId {
    const cp = this.checkpoints.get(checkpointId);
    if (cp === undefined) throw new ForkError(`unknown checkpoint: ${checkpointId}`);

    // Every pending invocation at the cut MUST have an explicit disposition (A1).
    for (const p of cp.pending) {
      const d = opts.dispositions[p.id];
      if (d === undefined) {
        throw new ForkError(`fork requires an explicit disposition for pending invocation ${p.id} (${p.effectClass})`);
      }
      if (d === 're-lease' && UNSAFE_TO_AUTO_RETRY.has(p.effectClass)) {
        const allowed = opts.allowReplayOfProtected?.keys.includes(p.effectKey) === true;
        if (!allowed) {
          throw new ForkError(`re-lease refused for ${p.effectClass} pending ${p.id}: outcome unknown, replay could double-apply`);
        }
      }
    }

    const childId = this.nextId('exec') as ExecutionId;
    const snap = this.storage.getBlob(cp.stateSnapshot) as {
      cell: [string, unknown][];
      artifacts: ArtifactRef[];
      effectIndex: [EffectKey, EffectIndexEntry][];
      evidence: [InvocationId, 'pass' | 'fail'][];
    };

    const protectedEffects = new Set<EffectKey>(cp.protectedEffects);
    const overridden = new Set<EffectKey>(opts.allowReplayOfProtected?.keys ?? []);
    for (const k of overridden) protectedEffects.delete(k);

    // Everything crossing the cut is INHERITED, not this lineage's own work.
    // An explicitly overridden key is dropped entirely so the child may redo it.
    const effectIndex = new Map<EffectKey, EffectIndexEntry>(
      snap.effectIndex
        .filter(([k]) => !overridden.has(k))
        .map(([k, e]) => [k, { ...e, inherited: true }]),
    );
    for (const p of cp.pending) {
      const d = opts.dispositions[p.id]!;
      if (d === 'adopt') {
        effectIndex.set(p.effectKey, { invocationId: p.id, effectClass: p.effectClass, landed: true, outcome: 'completed' });
        if (p.effectClass === 'external-irreversible') protectedEffects.add(p.effectKey);
      } else if (d === 'abandon') {
        effectIndex.set(p.effectKey, { invocationId: p.id, effectClass: p.effectClass, landed: false, outcome: 'failed' });
      } else if (d === 're-lease' || d === 'compensate') {
        effectIndex.delete(p.effectKey);
        protectedEffects.delete(p.effectKey);
      }
    }

    const child: ExecutionState = {
      executionId: childId,
      correlationId: this.mustExec(cp.executionId).correlationId,
      seq: 0,
      lastHash: 'genesis',
      definitionHash: opts.definitionHash ?? cp.definitionHash,
      parent: { executionId: cp.executionId, checkpointId: cp.id, cutSeq: cp.cutSeq },
      invocations: new Map(),
      cell: new Map(snap.cell),
      artifacts: [...snap.artifacts],
      effectIndex,
      dedupWindow: new Set(cp.dedupWindow),
      protectedEffects,
      grants: new Map(cp.grants.map((g) => [g.id, g])),
      cancelRequested: new Set(),
      evidence: new Map(snap.evidence),
    };
    this.executions.set(childId, child);

    // Grant handles are re-resolved at fork time: a grant revoked after the cut stays
    // revoked in the child (petname semantics, amendment A8 / ADR-013).
    const parentExec = this.mustExec(cp.executionId);
    for (const [gid, g] of child.grants) {
      const current = parentExec.grants.get(gid);
      if (current?.revoked === true) child.grants.set(gid, { ...g, revoked: true });
    }

    // The child's journal MUST be self-sufficient. Materializing the inherited state
    // into the child's own first commit is what makes that true: recovery rebuilds the
    // fork from its own records, with no dependency on a checkpoint blob that could be
    // absent, garbage-collected, or silently divergent.
    //
    // (Falsified by adversarial review #2: recovery rebuilt each execution from its own
    // journal only, so a restart erased everything a fork inherited — including the
    // protected-effect set — and an irreversible effect re-executed with zero invariant
    // violations reported. See docs/20 F-8.)
    const inheritedEffects = [...effectIndex.entries()].map(([k, v]) => [k, v] as const);
    const inheritedDigest = sha({
      snapshot: cp.stateSnapshot,
      protectedEffects: [...protectedEffects].sort(),
      effects: inheritedEffects.map(([k, v]) => [k, v.outcome, v.effectClass, v.landed]).sort(),
      grants: [...child.grants.values()].map((g) => [g.id, g.revoked, g.limits, g.rights]),
    });

    this.commit(child, [
      {
        kind: 'execution.forked',
        actorId: 'kernel',
        payload: {
          parentExecution: cp.executionId,
          checkpointId: cp.id,
          cutSeq: cp.cutSeq,
          dispositions: opts.dispositions,
          definitionHash: child.definitionHash,
          replayOverride: opts.allowReplayOfProtected ?? null,
          correlationId: child.correlationId,
          // The snapshot is content-addressed, so naming it in the journal attests it.
          snapshotRef: cp.stateSnapshot,
          inheritedDigest,
        },
      },
      {
        kind: 'grant.inherited',
        actorId: 'kernel',
        payload: { grants: [...child.grants.values()] },
      },
      {
        kind: 'effects.inherited',
        actorId: 'kernel',
        payload: {
          effects: inheritedEffects,
          protectedEffects: [...protectedEffects],
          dedupWindow: [...child.dedupWindow],
        },
      },
    ]);
    return childId;
  }

  // -------------------------------------------------------------------------
  // Commit — the single durable-truth path
  // -------------------------------------------------------------------------

  private commit(exec: ExecutionState, drafts: readonly DraftEvent[]): readonly KernelEvent[] {
    const events: KernelEvent[] = [];
    let seq = exec.seq;
    let prev = exec.lastHash;
    for (const d of drafts) {
      seq += 1;
      const base = {
        id: this.nextId('ev') as EventId,
        seq,
        kind: d.kind,
        schemaVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
        executionId: exec.executionId,
        invocationId: d.invocationId,
        correlationId: exec.correlationId,
        causationId: d.causationId,
        actorId: d.actorId,
        grantId: d.grantId,
        occurredAt: this.tick(),
        payload: d.payload,
        artifacts: d.artifacts,
      };
      const self = sha({ ...base, prev });
      const ev: KernelEvent = { ...base, integrity: { prev, self } };
      events.push(ev);
      prev = self;
    }

    const record = { commitToken: this.nextId('ct'), executionId: exec.executionId, events, checksum: sha(events) };
    // Atomic: this either lands whole or is discarded as torn at recovery.
    this.storage.appendCommit(record);

    // Projections advance only AFTER the durable write succeeds.
    exec.seq = seq;
    exec.lastHash = prev;
    for (const ev of events) this.applyToProjection(exec, ev);
    return events;
  }

  /** The fold. Used identically by live commit, recovery, and fork. */
  private applyToProjection(exec: ExecutionState, ev: KernelEvent): void {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.kind) {
      case 'invocation.admitted':
        exec.invocations.set(ev.invocationId!, {
          id: ev.invocationId!,
          executionId: exec.executionId,
          capabilityId: p['capabilityId'] as string,
          effectKey: p['effectKey'] as EffectKey,
          effectClass: p['effectClass'] as EffectClass,
          grantId: ev.grantId!,
          state: 'admitted',
          attempt: 1,
          leaseEpoch: 1,
        });
        break;
      case 'invocation.dispatched':
        this.patchInv(exec, ev.invocationId!, { state: 'dispatched' });
        break;
      case 'invocation.completed':
        this.patchInv(exec, ev.invocationId!, { state: 'completed' });
        break;
      case 'invocation.failed':
        this.patchInv(exec, ev.invocationId!, { state: 'failed' });
        break;
      case 'invocation.canceled':
        this.patchInv(exec, ev.invocationId!, { state: 'canceled' });
        break;
      case 'invocation.suspended':
        this.patchInv(exec, ev.invocationId!, {
          state: 'suspended',
          suspension: { reason: p['reason'] as string, payload: p['payload'] },
        });
        break;
      case 'invocation.uncertain':
        this.patchInv(exec, ev.invocationId!, {
          state: 'uncertain',
          uncertainty: { descriptor: p['descriptor'] as string, since: ev.occurredAt },
        });
        break;
      case 'state.updated':
        exec.cell.set(p['key'] as string, p['value']);
        break;
      case 'artifact.produced':
        exec.artifacts.push(p['ref'] as ArtifactRef);
        break;
      case 'evidence.produced':
        exec.evidence.set(ev.invocationId!, p['verdict'] as 'pass' | 'fail');
        break;
      case 'grant.issued':
      case 'grant.attenuated':
        if (!exec.grants.has(ev.grantId!)) {
          exec.grants.set(ev.grantId!, {
            id: ev.grantId!,
            parent: p['parent'] as GrantId | undefined,
            rights: p['rights'] as string[],
            limits: p['limits'] as Record<string, number>,
            reserved: {},
            settled: {},
            revoked: false,
          });
        }
        break;
      case 'grant.reserved':
        this.moveBudget(exec, ev.grantId!, p['units'] as Record<string, number>, 'reserved', +1);
        break;
      case 'grant.settled':
        this.moveBudget(exec, ev.grantId!, { invocations: 1 }, 'reserved', -1);
        this.moveBudget(exec, ev.grantId!, p['units'] as Record<string, number>, 'settled', +1);
        break;
      case 'grant.released':
        this.moveBudget(exec, ev.grantId!, p['units'] as Record<string, number>, 'reserved', -1);
        break;
      case 'grant.revoked': {
        const g = exec.grants.get(ev.grantId!);
        if (g !== undefined) exec.grants.set(g.id, { ...g, revoked: true });
        break;
      }
      case 'execution.forked': {
        // Rehydrate the inherited cell/artifact state from the attested snapshot.
        exec.parent = {
          executionId: p['parentExecution'] as ExecutionId,
          checkpointId: p['checkpointId'] as CheckpointId,
          cutSeq: p['cutSeq'] as number,
        };
        exec.definitionHash = (p['definitionHash'] as string) ?? exec.definitionHash;
        const ref = p['snapshotRef'] as string | undefined;
        if (ref !== undefined && this.storage.hasBlob(ref)) {
          const snap = this.storage.getBlob(ref) as { cell: [string, unknown][]; artifacts: ArtifactRef[] };
          for (const [key, value] of snap.cell) exec.cell.set(key, value);
          exec.artifacts.push(...snap.artifacts);
        }
        break;
      }
      case 'grant.inherited': {
        for (const g of (p['grants'] as GrantState[] | undefined) ?? []) exec.grants.set(g.id, g);
        break;
      }
      case 'effects.inherited': {
        for (const [key, entry] of (p['effects'] as [EffectKey, EffectIndexEntry][] | undefined) ?? []) {
          exec.effectIndex.set(key, entry);
        }
        for (const key of (p['protectedEffects'] as EffectKey[] | undefined) ?? []) exec.protectedEffects.add(key);
        for (const key of (p['dedupWindow'] as EffectKey[] | undefined) ?? []) exec.dedupWindow.add(key);
        break;
      }
      default:
        break;
    }
  }

  private patchInv(exec: ExecutionState, id: InvocationId, patch: Partial<InvocationRecord>): void {
    const cur = exec.invocations.get(id);
    if (cur !== undefined) exec.invocations.set(id, { ...cur, ...patch } as InvocationRecord);
  }

  private moveBudget(
    exec: ExecutionState,
    grantId: GrantId,
    units: Record<string, number>,
    bucket: 'reserved' | 'settled',
    sign: 1 | -1,
  ): void {
    for (const g of this.chain(exec, grantId)) {
      const next = { ...g[bucket] } as Record<string, number>;
      for (const [u, v] of Object.entries(units ?? {})) next[u] = Math.max(0, (next[u] ?? 0) + sign * v);
      exec.grants.set(g.id, { ...g, [bucket]: next } as GrantState);
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Rebuild every execution from committed records only.
   *
   * Pending external invocations are triaged by DECLARED EFFECT CLASS:
   *  - safe classes are re-leasable;
   *  - unsafe classes become `uncertain` and are never auto-retried (I13, I15).
   */
  static recover(storage: Storage, providers: readonly CapabilityProvider[] = []): { kernel: Kernel; uncertain: InvocationId[]; discarded: number } {
    const k = new Kernel(storage);
    for (const p of providers) k.register(p);
    // Checkpoints are durable and MUST be reloaded: without this, a restarted kernel
    // cannot fork from its own checkpoints — the disaster-recovery case.
    // (Falsified by tests/universality.test.ts — see docs/20 F-4.)
    for (const raw of storage.allCheckpoints()) {
      const cp = raw as Checkpoint;
      k.checkpoints.set(cp.id, cp);
    }
    const { records, discarded } = storage.readJournal();

    for (const rec of records) {
      const r = rec as { executionId: ExecutionId; events: KernelEvent[] };
      let exec = k.executions.get(r.executionId);
      if (exec === undefined) {
        const created = r.events.find((e) => e.kind === 'execution.created' || e.kind === 'execution.forked');
        exec = {
          executionId: r.executionId,
          correlationId: (created?.payload['correlationId'] as string) ?? r.executionId,
          seq: 0,
          lastHash: 'genesis',
          definitionHash: (created?.payload['definitionHash'] as string) ?? 'D1',
          parent: created?.kind === 'execution.forked'
            ? {
                executionId: created.payload['parentExecution'] as ExecutionId,
                checkpointId: created.payload['checkpointId'] as CheckpointId,
                cutSeq: created.payload['cutSeq'] as number,
              }
            : undefined,
          invocations: new Map(),
          cell: new Map(),
          artifacts: [],
          effectIndex: new Map(),
          dedupWindow: new Set(),
          protectedEffects: new Set(),
          grants: new Map(),
          cancelRequested: new Set(),
          evidence: new Map(),
        };
        k.executions.set(r.executionId, exec);
      }
      for (const ev of r.events) {
        k.applyToProjection(exec, ev);
        exec.seq = ev.seq;
        exec.lastHash = ev.integrity.self;
        // Rebuild effect identity from committed truth — including the REAL effect
        // class and the protected-effect set. Recovering these with a placeholder
        // class silently disarms the fork protections of doc 17 §8.2: after a restart
        // an inherited irreversible effect would again be absorbed as a cache hit.
        // (Falsified by an attack script during review #2 — see docs/20 F-6.)
        const key = ev.payload['effectKey'] as EffectKey | undefined;
        if (key !== undefined) {
          const known = ev.invocationId !== undefined ? exec.invocations.get(ev.invocationId) : undefined;
          const effectClass: EffectClass =
            (ev.payload['effectClass'] as EffectClass | undefined) ?? known?.effectClass ?? 'pure';
          const landed = ev.payload['landedExternal'] === true;
          if (ev.kind === 'invocation.completed') {
            exec.effectIndex.set(key, { invocationId: ev.invocationId!, effectClass, landed: true, outcome: 'completed' });
            exec.dedupWindow.add(key);
            if (effectClass === 'external-irreversible') exec.protectedEffects.add(key);
          } else if (ev.kind === 'invocation.failed' || ev.kind === 'invocation.canceled') {
            exec.effectIndex.set(key, { invocationId: ev.invocationId!, effectClass, landed, outcome: 'failed' });
            // A landed irreversible effect stays protected even when its invocation
            // failed afterwards: the world saw it.
            if (landed && effectClass === 'external-irreversible') exec.protectedEffects.add(key);
          }
        }
      }
      // Restore the counter so post-recovery ids never collide with committed ones.
      for (const ev of r.events) {
        const n = Number(ev.id.split('_')[1] ?? 0);
        if (n > k.counter) k.counter = n;
        if (ev.occurredAt > k.logicalClock) k.logicalClock = ev.occurredAt;
      }
    }

    // Triage: dispatched-with-no-outcome ⇒ the effect may or may not have landed.
    const uncertain: InvocationId[] = [];
    for (const exec of k.executions.values()) {
      for (const inv of exec.invocations.values()) {
        if (inv.state !== 'dispatched') continue;
        if (UNSAFE_TO_AUTO_RETRY.has(inv.effectClass)) {
          k.commit(exec, [
            {
              kind: 'invocation.uncertain',
              actorId: 'kernel',
              invocationId: inv.id,
              grantId: inv.grantId,
              payload: { descriptor: `crash after dispatch of ${inv.effectClass}`, effectKey: inv.effectKey },
            },
          ]);
          uncertain.push(inv.id);
        }
      }
    }
    return { kernel: k, uncertain, discarded };
  }

  // -------------------------------------------------------------------------
  // Read-only projections (userland sees only committed truth)
  // -------------------------------------------------------------------------

  state(executionId: ExecutionId): Readonly<ExecutionState> {
    return this.mustExec(executionId);
  }

  executionIds(): ExecutionId[] {
    return [...this.executions.keys()];
  }

  getCheckpoint(id: CheckpointId): Checkpoint | undefined {
    return this.checkpoints.get(id);
  }

  /** Committed events for one execution, in order. */
  events(executionId: ExecutionId): KernelEvent[] {
    const out: KernelEvent[] = [];
    for (const rec of this.storage.readJournal().records) {
      const r = rec as { executionId: ExecutionId; events: KernelEvent[] };
      if (r.executionId === executionId) out.push(...r.events);
    }
    return out;
  }

  /** Staged-but-uncommitted proposals. Visible to the kernel only; never durable. */
  stagedCount(): number {
    return this.staged.size;
  }

  private mustExec(id: ExecutionId): ExecutionState {
    const e = this.executions.get(id);
    if (e === undefined) throw new KernelError(`unknown execution: ${id}`);
    return e;
  }
}

export { canonical, sha };
