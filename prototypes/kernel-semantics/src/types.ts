/**
 * Kyxo kernel-semantics prototype — record format and contracts.
 *
 * This is the executable form of docs/17-KERNEL-SEMANTICS.md. It is deliberately
 * separate from prototypes/kernel/ (the phase-1 universality demo), because the
 * phase-1 provider contract handed every capability a live kernel handle, which is
 * exactly the commit-barrier bypass this phase exists to remove.
 *
 * THE STRUCTURAL RULE OF THIS FILE: a CapabilityProvider receives `InvokeCtx`, which
 * contains DATA ONLY — no kernel, no journal, no artifact store, no grant table, no
 * delegation function. The single channel by which a capability can affect durable
 * truth is yielding EffectProposals, which the kernel validates, stages, and commits.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type ExecutionId = string & { readonly __brand: 'ExecutionId' };
export type InvocationId = string & { readonly __brand: 'InvocationId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type ArtifactRef = string & { readonly __brand: 'ArtifactRef' };
export type CheckpointId = string & { readonly __brand: 'CheckpointId' };
export type GrantId = string & { readonly __brand: 'GrantId' };
export type BindingId = string & { readonly __brand: 'BindingId' };

/** Deterministic effect identity. Content-inclusive per amendment A1. */
export type EffectKey = string & { readonly __brand: 'EffectKey' };

// ---------------------------------------------------------------------------
// Effect classes — the taxonomy that drives every recovery decision.
// The kernel branches on THIS (a declared, negotiated property), never on what
// kind of thing a capability is. See docs/18 invariant I1.
// ---------------------------------------------------------------------------

export type EffectClass =
  /** No effect outside the kernel. Safe to re-execute freely. */
  | 'pure'
  /** Mutates kernel-owned state only (cells, artifacts). Re-executable under dedup. */
  | 'local'
  /** External, declared idempotent under the effect key. Safe to re-lease after crash. */
  | 'external-idempotent'
  /** External, not idempotent, but reversible via a declared compensation. */
  | 'external-compensatable'
  /** External, not idempotent, not reversible. NEVER auto-retried. */
  | 'external-irreversible';

export const EXTERNAL_CLASSES: ReadonlySet<EffectClass> = new Set<EffectClass>([
  'external-idempotent',
  'external-compensatable',
  'external-irreversible',
]);

/** Classes whose re-execution after an unknown outcome could double-apply. */
export const UNSAFE_TO_AUTO_RETRY: ReadonlySet<EffectClass> = new Set<EffectClass>([
  'external-compensatable',
  'external-irreversible',
]);

// ---------------------------------------------------------------------------
// Capability traits — declared, negotiated properties (docs/17 §11).
// Branching on these is legitimate; branching on "is this an agent or a tool" is not.
// ---------------------------------------------------------------------------

export interface CapabilityTraits {
  /** Effect class this capability's invocations produce, unless overridden per request. */
  readonly effectClass: EffectClass;
  /** Can the kernel ask "did my effect land?" after an uncertain outcome? */
  readonly probeable: boolean;
  /** Can the kernel run a declared compensation for a landed effect? */
  readonly compensatable: boolean;
  /** May the capability suspend and be re-entered with a typed payload? */
  readonly resumable: boolean;
  /** Does it emit incremental output before an outcome? (advisory plane only) */
  readonly streaming: boolean;
  /** Does it honor cooperative cancellation? */
  readonly cancellable: boolean;
  /** Is the capability's own state carried outside the kernel (provider sessions)? */
  readonly externallyStateful: boolean;
}

/**
 * How a budget unit behaves for one capability. Declared, negotiated data — the kernel
 * branches on this the way it branches on effect class, never on capability identity.
 *
 * `metered` is the trust statement, and it decides what settlement charges:
 *
 *   metered: true   the provider reports authoritative consumption (an LLM returning its
 *                   token counts). A declaration BELOW the reservation is accepted, so
 *                   accounting tracks reality and an over-estimate is refunded.
 *   metered: false  nobody measures this unit. The declaration is a capability's own
 *                   word about its own spending, so accepting a reduction would make a
 *                   budget depend on the honesty of untrusted code. Settlement charges
 *                   the full reservation.
 *
 * `perInvocation` is the floor the kernel reserves even when the caller estimates
 * nothing, which is what stops budget enforcement from being opt-in (docs/20 F-15).
 */
export interface UnitPolicy {
  readonly perInvocation: number;
  readonly metered: boolean;
}

export interface CapabilityManifest {
  readonly id: string;
  readonly version: string;
  readonly traits: CapabilityTraits;
  /** Tiered axes; ladders are manifest DATA so the kernel never knows axis semantics (A10). */
  readonly axes: Readonly<Record<string, { readonly value: string; readonly ladder: readonly string[] }>>;
  /** Budget units this capability consumes. Absent unit ⇒ nothing is reserved for it. */
  readonly units?: Readonly<Record<string, UnitPolicy>> | undefined;
}

// ---------------------------------------------------------------------------
// The capability contract. Note what is absent: any kernel reference.
// ---------------------------------------------------------------------------

export interface InvokeCtx {
  readonly invocationId: InvocationId;
  readonly executionId: ExecutionId;
  /** Logical clock value. Injected — capabilities never read a wall clock. */
  readonly now: number;
  readonly attempt: number;
  readonly request: unknown;
  /** Present only when the kernel re-enters after a suspension. */
  readonly resume?: { readonly payload: unknown } | undefined;
  /** Cooperative cancellation. Read-only signal. */
  readonly cancelled: () => boolean;
}

/**
 * What a capability may propose. The kernel validates, stages, and commits these.
 * A proposal is NOT durable truth until the kernel commits it.
 */
export type EffectProposal =
  | { readonly type: 'artifact'; readonly content: unknown; readonly labels?: readonly string[] }
  | { readonly type: 'state'; readonly key: string; readonly value: unknown }
  | { readonly type: 'usage'; readonly units: Readonly<Record<string, number>> }
  /** External effect performed (or believed performed) by the capability. */
  | { readonly type: 'external'; readonly descriptor: string; readonly landed: boolean }
  /** Evidence supporting an outcome; commit gates may require this (docs/17 §5). */
  | { readonly type: 'evidence'; readonly verdict: 'pass' | 'fail'; readonly detail: unknown }
  /**
   * Delegation WITHOUT a kernel handle: the capability asks the kernel to invoke
   * another capability and receives the outcome back through the generator channel.
   * The kernel attenuates authority for the child, so delegation cannot widen a grant.
   */
  | { readonly type: 'delegate'; readonly capabilityId: string; readonly request: unknown; readonly step?: string }
  /** Advisory-plane only: never committed, never durable. */
  | { readonly type: 'progress'; readonly note: string };

/** What the kernel sends back into the generator after a delegate proposal. */
export interface DelegationOutcome {
  readonly state: InvocationState;
  readonly output?: unknown;
  readonly error?: string | undefined;
}

export type CapabilityResult =
  | { readonly status: 'ok'; readonly output: unknown }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'suspend'; readonly reason: string; readonly payload: unknown };

export interface CapabilityProvider {
  readonly manifest: CapabilityManifest;
  /** Yields proposals; returns the outcome. Receives no kernel handle. */
  invoke(ctx: InvokeCtx): AsyncGenerator<EffectProposal, CapabilityResult, DelegationOutcome | undefined>;
  /** Only meaningful when traits.probeable. Answers "did effect <key> land?" */
  probe?(key: EffectKey): Promise<'landed' | 'not-landed' | 'unknown'>;
  /** Only meaningful when traits.compensatable. */
  compensate?(key: EffectKey): Promise<'compensated' | 'failed'>;
}

// ---------------------------------------------------------------------------
// Events and the journal record format
// ---------------------------------------------------------------------------

export type EventKind =
  | 'execution.created'
  | 'execution.forked'
  /** Inherited authority materialized into the child's own journal (see docs/20 F-8). */
  | 'grant.inherited'
  /** Inherited effect identity and protected effects, likewise materialized. */
  | 'effects.inherited'
  | 'invocation.admitted'
  | 'invocation.dispatched'
  | 'invocation.completed'
  | 'invocation.failed'
  | 'invocation.suspended'
  | 'invocation.resumed'
  | 'invocation.cancel.requested'
  | 'invocation.canceled'
  | 'invocation.uncertain'
  | 'invocation.uncertainty.resolved'
  | 'artifact.produced'
  | 'state.updated'
  | 'evidence.produced'
  | 'grant.issued'
  | 'grant.attenuated'
  | 'grant.reserved'
  | 'grant.settled'
  | 'grant.released'
  | 'grant.revoked'
  | 'grant.denied'
  | 'effect.deduplicated'
  | 'delivery.duplicate'
  | 'commit.retried'
  | 'checkpoint.cut'
  | 'policy.denied';

export interface KernelEvent {
  readonly id: EventId;
  /** Execution-local dense monotonic position. The recovery cursor. */
  readonly seq: number;
  readonly kind: EventKind;
  readonly schemaVersion: number;
  readonly protocolVersion: string;
  readonly executionId: ExecutionId;
  readonly invocationId?: InvocationId | undefined;
  readonly correlationId: string;
  readonly causationId?: EventId | undefined;
  /** Stamped kernel-side. Never writer-supplied. */
  readonly actorId: string;
  readonly grantId?: GrantId | undefined;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
  /** Hash chain over the execution's committed history. */
  readonly integrity: { readonly prev: string; readonly self: string };
}

/**
 * The unit of atomicity. A commit record lands entirely or not at all.
 * Recovery discards a trailing torn record (checksum mismatch).
 */
export interface CommitRecord {
  readonly commitToken: string;
  readonly executionId: ExecutionId;
  readonly events: readonly KernelEvent[];
  readonly checksum: string;
}

// ---------------------------------------------------------------------------
// Grants — handle-based (amendment A8). Userland cannot forge or widen one.
// ---------------------------------------------------------------------------

export type BudgetUnits = Readonly<Record<string, number>>;

export interface GrantState {
  readonly id: GrantId;
  readonly parent?: GrantId | undefined;
  readonly rights: readonly string[];
  readonly limits: BudgetUnits;
  readonly reserved: BudgetUnits;
  readonly settled: BudgetUnits;
  readonly revoked: boolean;
  readonly expiresAt?: number | undefined;
}

/**
 * Unforgeable authority reference.
 *
 * Authority is OBJECT IDENTITY, not a token field: the kernel keeps a private WeakSet
 * of the handles it minted and accepts nothing else. Copying the class, reading the id
 * off a journal event, or reconstructing the shape with Object.create all fail, because
 * none of those objects are in the kernel's registry.
 *
 * (Falsified first attempt: a `KERNEL_MINT` guard symbol exported from this module was
 * importable by anyone, so any module could mint a valid handle. See docs/20 F-2.)
 */
export class GrantHandle {
  readonly id: GrantId;
  constructor(id: GrantId) {
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Invocation lifecycle
// ---------------------------------------------------------------------------

export type InvocationState =
  | 'admitted'
  | 'dispatched'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'canceled'
  /** External outcome unknown. Explicitly represented, never guessed (I15). */
  | 'uncertain';

export const TERMINAL_STATES: ReadonlySet<InvocationState> = new Set<InvocationState>([
  'completed',
  'failed',
  'canceled',
]);

export interface InvocationRecord {
  readonly id: InvocationId;
  readonly executionId: ExecutionId;
  readonly capabilityId: string;
  readonly effectKey: EffectKey;
  readonly effectClass: EffectClass;
  readonly grantId: GrantId;
  readonly state: InvocationState;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly suspension?: { readonly reason: string; readonly payload: unknown } | undefined;
  /**
   * The commit gate is a property of the INVOCATION, not of the call that made it.
   * Holding it only in InvokeOptions let the resume path drop it (review #2 FATAL:
   * suspend, then ship with failing evidence). See docs/20 F-10.
   */
  readonly requiresEvidence: boolean;
  /** Set when state === 'uncertain'. */
  readonly uncertainty?: { readonly descriptor: string; readonly since: number } | undefined;
}

export type UncertaintyDisposition =
  | { readonly kind: 'probe' }
  | { readonly kind: 'adopt-landed'; readonly authority: string }
  | { readonly kind: 'compensate' }
  | { readonly kind: 'abandon-failed'; readonly authority: string };

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface PendingInvocation {
  readonly id: InvocationId;
  readonly effectKey: EffectKey;
  readonly effectClass: EffectClass;
  readonly leaseEpoch: number;
  readonly state: InvocationState;
}

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly executionId: ExecutionId;
  /** The consistency boundary: last COMMITTED seq folded into this cut. */
  readonly cutSeq: number;
  readonly stateSnapshot: ArtifactRef;
  readonly pending: readonly PendingInvocation[];
  /** Bounded reliability window only — NOT the unbounded replay cache (A11). */
  readonly dedupWindow: readonly EffectKey[];
  /** Effects that must never be re-executed by a fork (irreversible, already landed). */
  readonly protectedEffects: readonly EffectKey[];
  readonly grants: readonly GrantState[];
  readonly definitionHash: string;
  readonly protocolVersion: string;
}

export type ForkDisposition = 'adopt' | 're-lease' | 'compensate' | 'abandon';

export interface ForkOptions {
  /** Mandatory per pending invocation; fork fails loudly if any pending is unaddressed. */
  readonly dispositions: Readonly<Record<string, ForkDisposition>>;
  readonly definitionHash?: string;
  /** Explicit, journaled override for replaying a protected irreversible effect. */
  readonly allowReplayOfProtected?: { readonly keys: readonly EffectKey[]; readonly reason: string };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }
  | { readonly decision: 'suspend'; readonly reason: string };

export interface PolicyStage {
  readonly name: string;
  /** deny-class stages are non-bypassable regardless of mode. */
  readonly denyClass: boolean;
  evaluate(input: {
    readonly capabilityId: string;
    readonly effectClass: EffectClass;
    readonly grant: GrantState;
    readonly phase: 'admission' | 'commit';
    readonly proposals?: readonly EffectProposal[];
  }): PolicyDecision;
}

export const PROTOCOL_VERSION = '2026-08-16';
