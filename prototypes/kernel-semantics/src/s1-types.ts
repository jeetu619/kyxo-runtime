/**
 * Wave S1 — record format revision `2026-08-17`.
 *
 * Resolves blockers B1, B2, B3, B4, B8 (and B9a, B9b, which share the same records and
 * therefore could not be landed separately without a second breaking revision).
 *
 * THE FIVE STRUCTURAL CHANGES
 *
 *  1. B1 — Effect claims are acquired at ADMISSION, before dispatch, as committed
 *     records. Exclusivity is established durably before the world can be touched.
 *  2. B2/B9b — Grants are a FAMILY-scoped ledger keyed by grant id across the whole
 *     lineage tree, in every declared unit. Forking cannot reset or multiply authority.
 *  3. B3 — A landed external effect is committed WHEN YIELDED, not held as a candidate
 *     until settlement. Yield, suspension and crash cannot lose it.
 *  4. B4 — One authoritative fold derives all state. Live and replayed state must be
 *     equal for every committed prefix.
 *  5. B8 — Every event carries `payloadHash`; the chain covers the hash, not the payload,
 *     so redaction is possible without breaking integrity.
 *
 * SCOPE: BOTH LEDGERS ARE FAMILY-SCOPED
 *
 *   Protected effects are FAMILY-scoped: an exclusive effect landed anywhere in the
 *   lineage tree binds the whole tree, regardless of topology or of which cut a child
 *   came from. The external world is not forked — a lineage tree is bookkeeping, a
 *   charged card is a fact.
 *
 *   Grant budgets are FAMILY-scoped: money spent is spent. Every execution descending
 *   from one grant draws on one ledger, so no fork can mint spending power.
 *
 * Both are folds over committed records, so both survive restart (I25).
 *
 * SUPERSEDED: this file previously specified an ancestor-PATH scope for protection, on
 * the theory that siblings are divergent world-lines, and called that asymmetry the
 * load-bearing decision of the wave. Tests s1-lineage L1–L3 falsified it and produced a
 * second real charge; see docs/20 F-12. The asymmetry is gone: one scope, one rule.
 */

import type {
  ArtifactRef, CheckpointId, EffectClass, EffectKey, ExecutionId,
  GrantId, InvocationId, InvocationState,
} from './types.ts';

/**
 * Format candidate. `2026-08-17` and `2026-08-18` are HISTORICAL and their meanings are
 * fixed: journals written under them mean what they meant. S1b changed effect identity,
 * added writer identity and a MAC, and made unknown required kinds fail closed — all
 * semantic changes, so the identifier moves rather than the meaning (PART 19).
 *
 * `2026-08-18` → `2026-08-19` FOR THE SAME REASON, and the reason is easy to under-rate.
 * S1b-1 moved `requiredFeatures` and `mustUnderstand` inside both seals and separated the
 * checksum and MAC domains. No field changed name or type, so the change LOOKS additive —
 * but a seal recipe is not metadata about a record, it is the rule by which a reader
 * decides the record is genuine. A `2026-08-18` record and a `2026-08-19` record with
 * byte-identical fields carry different, non-interchangeable checksums, and neither reader
 * can verify the other's records.
 *
 * Two non-interoperable recipes under one identifier is the definition of an ambiguous
 * format: a reader holding a record stamped `2026-08-18` cannot tell which rule made it,
 * so it must either guess or accept both — and accepting both re-opens the gap the
 * revision closed. The identifier moves so that the question never arises. Doc 31 §7 named
 * this revision in advance; this is it.
 */
export const S1_PROTOCOL_VERSION = '2026-08-19';

/** Root of a lineage tree. Every execution forked from another shares its family. */
export type FamilyId = string & { readonly __brand: 'FamilyId' };
export type ClaimId = string & { readonly __brand: 'ClaimId' };

/** Budget units are open: any string unit may be reserved and settled (B9b). */
export type Units = Readonly<Record<string, number>>;

// ---------------------------------------------------------------------------
// Effect claims (B1)
// ---------------------------------------------------------------------------

/**
 * Exclusivity is derived from the DECLARED effect class, never from capability
 * identity: classes that cannot be safely repeated require exclusive possession.
 */
export function requiresExclusiveClaim(cls: EffectClass): boolean {
  return cls === 'external-irreversible' || cls === 'external-compensatable';
}

export type ClaimState =
  /** Acquired at admission; the holder may dispatch. */
  | 'held'
  /** The world is known to have seen the effect. Terminal for protection purposes. */
  | 'landed'
  /** Outcome unknown after a crash or timeout. Blocks re-dispatch (I15). */
  | 'uncertain'
  /** Known not to have reached the world; the key is free again. */
  | 'released'
  /** Landed and settled; retained as protection. */
  | 'settled';

export interface ClaimRecord {
  readonly claimId: ClaimId;
  readonly effectKey: EffectKey;
  readonly effectClass: EffectClass;
  readonly exclusive: boolean;
  readonly holder: InvocationId;
  readonly executionId: ExecutionId;
  readonly familyId: FamilyId;
  /** Sequence in the holder's execution at which the claim was committed. */
  readonly seq: number;
  readonly state: ClaimState;
}

/** A landed effect, recorded where and when it happened. The protected-effect ledger. */
export interface LandedEffect {
  readonly effectKey: EffectKey;
  readonly effectClass: EffectClass;
  readonly executionId: ExecutionId;
  readonly seq: number;
  readonly descriptor: string;
}

// ---------------------------------------------------------------------------
// Family-scoped grant ledger (B2, B9b)
// ---------------------------------------------------------------------------

export interface GrantLedgerEntry {
  readonly id: GrantId;
  readonly parent?: GrantId | undefined;
  readonly familyId: FamilyId;
  readonly rights: readonly string[];
  readonly limits: Units;
  /** Held for in-flight invocations, in every declared unit. */
  readonly reserved: Units;
  /** Consumed, in every declared unit. Family-wide: forks share one ledger. */
  readonly settled: Units;
  readonly revoked: boolean;
  readonly expiresAt?: number | undefined;
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export interface LineageNode {
  readonly executionId: ExecutionId;
  readonly familyId: FamilyId;
  readonly parent?: { readonly executionId: ExecutionId; readonly cutSeq: number } | undefined;
}

// ---------------------------------------------------------------------------
// Event envelope v2 (B8)
// ---------------------------------------------------------------------------

export type S1EventKind =
  | 'execution.created' | 'execution.forked'
  | 'invocation.admitted' | 'invocation.dispatched'
  | 'invocation.completed' | 'invocation.failed' | 'invocation.canceled'
  | 'invocation.suspended' | 'invocation.resumed' | 'invocation.uncertain'
  | 'invocation.cancel.requested' | 'invocation.uncertainty.resolved'
  | 'effect.claimed' | 'effect.claim.denied' | 'effect.landed'
  | 'effect.released' | 'effect.settled' | 'effect.deduplicated'
  | 'artifact.produced' | 'state.updated' | 'evidence.produced'
  | 'grant.issued' | 'grant.attenuated' | 'grant.reserved' | 'grant.settled'
  | 'grant.released' | 'grant.revoked' | 'grant.denied'
  | 'delivery.duplicate' | 'checkpoint.cut' | 'policy.denied';

export interface S1Event {
  readonly id: string;
  readonly seq: number;
  readonly kind: S1EventKind;
  readonly schemaVersion: number;
  readonly protocolVersion: string;
  readonly executionId: ExecutionId;
  readonly familyId: FamilyId;
  readonly invocationId?: InvocationId | undefined;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly actorId: string;
  readonly grantId?: GrantId | undefined;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * B8: hash of the canonical payload. The chain covers THIS, not the payload itself,
   * so a payload may be tombstoned for redaction while integrity still verifies.
   */
  readonly payloadHash: string;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
  readonly integrity: { readonly prev: string; readonly self: string };
}

export interface S1CommitRecord {
  readonly commitToken: string;
  readonly executionId: ExecutionId;
  readonly familyId: FamilyId;
  readonly events: readonly S1Event[];
  /** Covers the WHOLE record, not just the events (review #2 finding). */
  readonly checksum: string;
}

// ---------------------------------------------------------------------------
// Derived state — produced ONLY by the fold (B4)
// ---------------------------------------------------------------------------

export interface ExecutionProjection {
  readonly executionId: ExecutionId;
  familyId: FamilyId;
  correlationId: string;
  seq: number;
  lastHash: string;
  definitionHash: string;
  parent?: { executionId: ExecutionId; cutSeq: number } | undefined;
  invocations: Map<InvocationId, {
    id: InvocationId;
    capabilityId: string;
    /**
     * The original request. Stored so a suspended invocation can be re-entered from the
     * journal alone: re-entry that depends on process memory is re-entry that stops
     * working at the first restart (I25).
     */
    request: unknown;
    effectKey: EffectKey;
    effectClass: EffectClass;
    grantId: GrantId;
    state: InvocationState;
    requiresEvidence: boolean;
    /**
     * What the kernel is holding for this invocation, in every unit. Folded from
     * `grant.reserved` rather than kept in memory, because a resume or a restart has to
     * release exactly what admission held — and a reservation that only lives in the
     * process is one that leaks on every crash.
     */
    reservation: Units;
    /**
     * Units whose consumption is authoritatively reported by the provider, as negotiated
     * AT ADMISSION. Journaled for the same reason `effectClass` is: it decides an
     * authoritative ledger movement, so reading it from the in-process capability registry
     * at settlement would let a manifest edited between admission and settlement — or
     * simply re-supplied differently after a restart — change what a committed invocation
     * costs. See docs/20 F-20.
     */
    meteredUnits: readonly string[];
    suspension?: { reason: string; payload: unknown } | undefined;
  }>;
  cell: Map<string, unknown>;
  artifacts: ArtifactRef[];
  evidence: Map<InvocationId, 'pass' | 'fail'>;
  cancelRequested: Set<InvocationId>;
}

/**
 * One family = one lineage tree = one unit of derived truth.
 * Claims, landed effects and grants live HERE, not per execution, because forking must
 * not reset them.
 */
export interface FamilyProjection {
  readonly familyId: FamilyId;
  executions: Map<ExecutionId, ExecutionProjection>;
  lineage: Map<ExecutionId, LineageNode>;
  /** Active + terminal claims, keyed by effect identity. */
  claims: Map<EffectKey, ClaimRecord>;
  /** Every landed effect with where it landed — family-scoped protection reads this. */
  landed: LandedEffect[];
  /** One ledger per grant id for the whole family (B2). */
  grants: Map<GrantId, GrantLedgerEntry>;
  /** Terminal outcomes by effect key, for dedup of safe classes. */
  outcomes: Map<EffectKey, { invocationId: InvocationId; state: InvocationState; output?: unknown }>;
}

export function emptyFamily(familyId: FamilyId): FamilyProjection {
  return {
    familyId,
    executions: new Map(),
    lineage: new Map(),
    claims: new Map(),
    landed: [],
    grants: new Map(),
    outcomes: new Map(),
  };
}
