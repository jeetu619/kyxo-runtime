/**
 * types.ts — the Kyxo kernel vocabulary (prototype).
 *
 * Implements DESIGN-SPINE.md §3 (nine kernel objects) and §4 (capability
 * contract) as strict TypeScript types.
 *
 * HONEST CHEATS, stated up front:
 *  - Artifact hashes are truncated sha256 over JSON.stringify with NO
 *    canonicalization: key order changes the hash. Proves content addressing,
 *    is not a real CAS.
 *  - "Unforgeable" Grants are plain objects behind a Map. In-process JS cannot
 *    make references unforgeable; the API shape is what is being validated.
 *  - The journal embeds artifact payloads inline (one JSONL file) instead of
 *    the spine's two-tier reference/CAS store, so a fresh process can rebuild
 *    the CAS from the journal alone.
 *  - Budget dimensions wall-clock and risk-class are omitted;
 *    tokens/money/invocations/spawnDepth are implemented.
 *
 * THE CORE RULE: nothing in this file or kernel.ts branches on what a
 * capability IS. Capabilities differ only by manifest content and provider
 * behaviour. Dispatch is table-driven over closed protocol discriminants
 * (journal record names, provider event opcodes) — never over capability
 * identity. validate.sh greps this by construction.
 */

// ---------------------------------------------------------------------------
// Capability manifest — three-tier grammar (spine §4): typed axes,
// experimental bag, governed reverse-DNS extensions.
// ---------------------------------------------------------------------------

/**
 * A typed axis value. Tiered axes carry their own ladder (ordered low → high)
 * so the kernel can compare tiers WITHOUT knowing what the axis means — tier
 * order is manifest data, not kernel knowledge.
 */
export type AxisValue =
  | { readonly shape: 'tiered'; readonly tier: string; readonly ladder: readonly string[] }
  | { readonly shape: 'options'; readonly offered: readonly string[] }
  | { readonly shape: 'flag'; readonly enabled: boolean };

export type StabilityClass = 'experimental' | 'testing' | 'stable' | 'deprecated';

export interface CapabilityIdentity {
  readonly id: string;
  readonly version: string;
  readonly stability: StabilityClass;
}

export interface CapabilityManifest {
  readonly identity: CapabilityIdentity;
  readonly summary: string;
  /** Tier 1: typed, named, negotiable axes. */
  readonly axes: Readonly<Record<string, AxisValue>>;
  /** Tier 2: experimental bag — visible, never negotiated, may vanish. */
  readonly experimental: Readonly<Record<string, unknown>>;
  /** Tier 3: governed reverse-DNS extensions with settings objects. */
  readonly extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// ---------------------------------------------------------------------------
// Negotiation & Binding (kernel object 2)
// ---------------------------------------------------------------------------

/** Requirement expression evaluated against manifest axes at bind time. */
export type AxisRequirement =
  | { readonly axis: string; readonly need: 'tier-at-least'; readonly tier: string; readonly optional?: boolean | undefined }
  | { readonly axis: string; readonly need: 'one-of'; readonly anyOf: readonly string[]; readonly optional?: boolean | undefined }
  | { readonly axis: string; readonly need: 'enabled'; readonly optional?: boolean | undefined }
  | { readonly axis: string; readonly need: 'present'; readonly optional?: boolean | undefined };

export interface BindRequest {
  readonly capabilityId: string;
  readonly grantId: string;
  readonly requirements: readonly AxisRequirement[];
}

/** Sealed result of negotiation: capability + chosen tiers + grant + policy route. */
export interface Binding {
  readonly id: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly grantId: string;
  /** Chosen tier/option/flag per required axis. */
  readonly negotiated: Readonly<Record<string, string | boolean>>;
  /** Manifest axes the requirements never mentioned (unknown-must-ignore). */
  readonly ignoredAxes: readonly string[];
  /** Optional required axes the manifest lacked (skipped, recorded). */
  readonly absentOptional: readonly string[];
  /** Policy stage names sealed into this binding at bind time. */
  readonly policyRoute: readonly string[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Invocation lifecycle (kernel object 3) — closed transition algebra
// ---------------------------------------------------------------------------

export const INVOCATION_STATES = [
  'submitted', 'working',
  'input-required', 'auth-required', 'approval-required', 'budget-exceeded',
  'completed', 'failed', 'canceled', 'rejected',
] as const;

export type InvocationState = (typeof INVOCATION_STATES)[number];
export type InterruptedState = 'input-required' | 'auth-required' | 'approval-required' | 'budget-exceeded';
export type TerminalState = 'completed' | 'failed' | 'canceled' | 'rejected';

/** The closed transition table. Anything not listed is a TransitionError. */
export const TRANSITION_TABLE: Readonly<Record<InvocationState, readonly InvocationState[]>> = {
  submitted: ['working', 'rejected', 'canceled', 'approval-required', 'budget-exceeded'],
  working: ['input-required', 'auth-required', 'approval-required', 'budget-exceeded', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'canceled', 'failed'],
  'auth-required': ['working', 'canceled', 'failed'],
  'approval-required': ['working', 'rejected', 'canceled', 'failed'],
  // self-loop: a resume attempt may run out of budget again before re-entering work
  'budget-exceeded': ['working', 'budget-exceeded', 'canceled', 'failed'],
  completed: [], failed: [], canceled: [], rejected: [],
};

export const INTERRUPTED: readonly InvocationState[] =
  ['input-required', 'auth-required', 'approval-required', 'budget-exceeded'];
export const TERMINAL: readonly InvocationState[] =
  ['completed', 'failed', 'canceled', 'rejected'];

/** Typed suspension record (Mastra suspend/resume-schema pattern, spine §3.3). */
export interface SuspensionRecord {
  readonly reason: InterruptedState;
  /** Who suspended: the provider, a policy stage, or the kernel (budgets). */
  readonly origin: 'provider' | 'policy' | 'kernel';
  readonly payload: unknown;
  readonly at: string;
  /** For policy-origin suspensions: pipeline position to resume after. */
  readonly policyIndex?: number | undefined;
}

export interface Invocation {
  readonly id: string;
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly cellId: string;
  /** Mutable: budget-exceeded resume may attach a fresh grant (re-grant verb — see findings). */
  grantId: string;
  readonly request: unknown;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly inputArtifacts: readonly string[];
  state: InvocationState;
  suspension?: SuspensionRecord | undefined;
  output?: unknown;
  outputArtifact?: string | undefined;
  error?: string | undefined;
  /** Position in the sealed policy route (resume must not re-run earlier stages). */
  policyIndex: number;
  providerStarted: boolean;
  cancelRequested: boolean;
  readonly submittedAt: string;
}

// ---------------------------------------------------------------------------
// Event (kernel object 4) — the append-only journal envelope (truth plane)
// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  'capability.registered', 'kind.registered', 'kind.object',
  'cell.created', 'cell.restored',
  'grant.created', 'grant.charged', 'grant.revoked',
  'binding.created', 'binding.rejected',
  'policy.decision',
  'invocation.submitted', 'invocation.transition', 'invocation.progress',
  'artifact.stored', 'checkpoint.created', 'probe.completed',
] as const;

export type KernelEventKind = (typeof EVENT_KINDS)[number];

export interface KernelEvent {
  readonly id: string;
  readonly seq: number;
  readonly kind: KernelEventKind;
  /** From the injected clock — never Date.now() inside the kernel. */
  readonly occurredAt: string;
  readonly cellId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly actorId: string;
  readonly artifactRefs: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Artifact (kernel object 5) — content-addressed, provenance, taint
// ---------------------------------------------------------------------------

export interface ArtifactProvenance {
  readonly producedBy?: string | undefined; // invocation id
  readonly inputs: readonly string[];       // artifact hashes consumed
}

export interface Artifact {
  readonly hash: string;
  readonly content: unknown;
  readonly provenance: ArtifactProvenance;
  /** Taint/integrity labels; propagate structurally from inputs to outputs. */
  readonly taint: readonly string[];
  readonly storedAt: string;
}

// ---------------------------------------------------------------------------
// Cell (kernel object 6) — keyed single-writer execution scope
// ---------------------------------------------------------------------------

export interface Cell {
  readonly id: string;
  readonly key: string;
  readonly createdAt: string;
  /**
   * Per-instance runtime flag, NOT journal state: replayed cells are inert
   * until restore(checkpointId) re-arms them. Gives restore() real semantics.
   */
  live: boolean;
  restoredFrom?: string | undefined;
}

// ---------------------------------------------------------------------------
// Grant (kernel object 7) — rights + quantitative budgets, attenuable lineage
// ---------------------------------------------------------------------------

/** null = unlimited (JSON-serializable, unlike Infinity). */
export type Budget = number | null;

export interface Budgets {
  readonly tokens: Budget;
  readonly moneyCents: Budget;
  readonly invocations: Budget;
  readonly spawnDepth: Budget;
}

export interface MutableBudgets {
  tokens: Budget;
  moneyCents: Budget;
  invocations: Budget;
  spawnDepth: Budget;
}

export interface GrantSpec {
  /** e.g. `invoke:some-capability` or the wildcard form `invoke:*`. */
  readonly rights: readonly string[];
  readonly budgets: Budgets;
  readonly label?: string | undefined;
}

export interface Grant {
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly rights: readonly string[];
  /** Remaining budgets — decremented by the kernel at commit points. */
  readonly budgets: MutableBudgets;
  readonly initial: Budgets;
  readonly label: string;
  revoked: boolean;
  readonly createdAt: string;
}

export interface ChargeSpec {
  readonly tokens?: number | undefined;
  readonly moneyCents?: number | undefined;
  readonly invocations?: number | undefined;
}

// ---------------------------------------------------------------------------
// Checkpoint (kernel object 8)
// ---------------------------------------------------------------------------

export interface CheckpointInvocationSnapshot {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly suspension?: SuspensionRecord | undefined;
}

export interface Checkpoint {
  readonly id: string;
  readonly cellId: string;
  /** Journal position of the consistent cut. */
  readonly journalSeq: number;
  readonly invocations: readonly CheckpointInvocationSnapshot[];
  /** Interrupted-class invocations awaiting resume. */
  readonly pending: readonly string[];
  readonly createdAt: string;
}

export interface RestoreResult {
  readonly cellId: string;
  readonly pending: readonly string[];
}

// ---------------------------------------------------------------------------
// Kind registry (kernel object 9) — userland types, CRD-style
// ---------------------------------------------------------------------------

export interface KindDefinition {
  /** Reverse-DNS name, e.g. `dev.kyxo.research/Objective`. */
  readonly name: string;
  readonly version: string;
  /** Returns validation problems; empty array = valid. */
  readonly validate: (payload: unknown) => readonly string[];
}

// ---------------------------------------------------------------------------
// Policy pipeline (kernel mechanism)
// ---------------------------------------------------------------------------

export type PolicyPhase = 'bind' | 'invoke';

export interface PolicyContext {
  readonly phase: PolicyPhase;
  readonly capabilityId: string;
  readonly manifest: CapabilityManifest;
  readonly grant: Grant;
  readonly request?: unknown;
  readonly invocationId?: string | undefined;
  readonly inputTaint: readonly string[];
}

export type PolicyDecision =
  | { readonly decision: 'allow'; readonly note?: string | undefined }
  /** Deny is never bypassable: the pipeline halts and the invocation is rejected. */
  | { readonly decision: 'deny'; readonly reason: string }
  | { readonly decision: 'suspend'; readonly reason: string; readonly payload: unknown };

export interface PolicyStage {
  readonly name: string;
  readonly phases: readonly PolicyPhase[];
  readonly evaluate: (ctx: PolicyContext) => PolicyDecision;
}

// ---------------------------------------------------------------------------
// Capability provider contract — the ONLY thing the kernel knows about any
// capability: an identity, a manifest, and a stream of typed events.
// ---------------------------------------------------------------------------

/** Providers may suspend for input/auth/approval; budget exhaustion is kernel-owned. */
export type SuspendReason = Exclude<InterruptedState, 'budget-exceeded'>;

export type CapabilityEvent =
  | { readonly op: 'progress'; readonly note: string; readonly data?: unknown }
  | { readonly op: 'charge'; readonly cost: ChargeSpec; readonly note?: string | undefined }
  | { readonly op: 'artifact'; readonly content: unknown; readonly taint?: readonly string[] | undefined; readonly label?: string | undefined }
  | { readonly op: 'suspend'; readonly reason: SuspendReason; readonly payload: unknown }
  | { readonly op: 'result'; readonly output: unknown }
  | { readonly op: 'fail'; readonly error: string };

export interface ResumeInput {
  readonly input: unknown;
  readonly suspension: SuspensionRecord;
}

export interface InvokeOptions {
  readonly cellId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly actorId?: string | undefined;
  readonly inputArtifacts?: readonly string[] | undefined;
}

export interface ResumeOptions {
  /** Attach a fresh grant when resuming from budget-exceeded (re-grant verb). */
  readonly grantId?: string | undefined;
}

export interface InvocationOutcome {
  readonly invocationId: string;
  readonly state: InvocationState;
  readonly output?: unknown;
  readonly outputArtifact?: string | undefined;
  readonly suspension?: SuspensionRecord | undefined;
  readonly error?: string | undefined;
}

/** Kernel facade handed to providers — composite capabilities delegate through it. */
export interface KernelApi {
  /** Capability discovery (spine §2): enumerate registered manifests.
   *  Minimal hook added for the graph prototype — requirement->binding
   *  resolution needs a registry to negotiate against, and the journal only
   *  records axis NAMES, not full manifests. */
  listCapabilities(): readonly CapabilityManifest[];
  bind(req: BindRequest): Binding;
  invoke(bindingId: string, request: unknown, opts?: InvokeOptions): Promise<InvocationOutcome>;
  resume(invocationId: string, payload: unknown, opts?: ResumeOptions): Promise<InvocationOutcome>;
  attenuate(parentGrantId: string, spec: GrantSpec): Grant;
  getGrant(grantId: string): Grant;
  storeArtifact(content: unknown, meta?: ArtifactMeta): string;
}

export interface ArtifactMeta {
  readonly producedBy?: string | undefined;
  readonly inputs?: readonly string[] | undefined;
  readonly taint?: readonly string[] | undefined;
}

export interface InvokeCtx {
  readonly invocationId: string;
  readonly cellId: string;
  readonly grantId: string;
  readonly clock: () => string;
  /** Present when the kernel re-enters the provider after a suspension. */
  readonly resume?: ResumeInput | undefined;
  readonly kernel: KernelApi;
}

export interface ProbeReport {
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface CapabilityProvider {
  readonly identity: CapabilityIdentity;
  readonly manifest: CapabilityManifest;
  invoke(request: unknown, ctx: InvokeCtx): AsyncIterable<CapabilityEvent>;
  probe?(ctx: { readonly clock: () => string }): Promise<ProbeReport>;
}

// ---------------------------------------------------------------------------
// Errors — loud by construction
// ---------------------------------------------------------------------------

export class KernelError extends Error {
  constructor(message: string) { super(message); this.name = 'KernelError'; }
}

export class BindError extends KernelError {
  constructor(message: string) { super(message); this.name = 'BindError'; }
}

export class AttenuationError extends KernelError {
  constructor(message: string) { super(message); this.name = 'AttenuationError'; }
}

export class BudgetExceeded extends KernelError {
  readonly grantId: string;
  readonly dimension: string;
  constructor(message: string, grantId: string, dimension: string) {
    super(message); this.name = 'BudgetExceeded';
    this.grantId = grantId; this.dimension = dimension;
  }
}

export class TransitionError extends KernelError {
  constructor(message: string) { super(message); this.name = 'TransitionError'; }
}

export class RestoreError extends KernelError {
  constructor(message: string) { super(message); this.name = 'RestoreError'; }
}
