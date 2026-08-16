/**
 * kernel.ts — the Kyxo kernel prototype.
 *
 * In-memory state + append-only JSONL journal as the truth plane. A fresh
 * Kernel instance constructed with { replay: true } rebuilds all state from
 * the journal alone (providers and policy stages are code and must be
 * re-registered — a checkpoint captures state, never code).
 *
 * HONEST CHEATS (see also types.ts header):
 *  - One process, one JSONL file, no locking: two live instances appending to
 *    the same journal are not coordinated (the demo exploits this knowingly).
 *  - Artifact payloads are embedded in journal records so replay can rebuild
 *    the CAS; the spine's two-tier reference/payload split is not honored.
 *  - restore() VALIDATES a checkpoint against replayed-to-tip state instead
 *    of rewinding the journal to the cut; fork-from-checkpoint is unbuilt.
 *  - Scheduler is a per-cell promise chain: single-writer turns, no leases,
 *    no deadlines.
 *
 * THE CORE RULE: zero branching on what a capability IS. All dispatch is over
 * closed protocol discriminants (journal record names via a total handler
 * table, provider event opcodes via an if-chain on `op`). validate.sh greps
 * this file for the forbidden patterns.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import {
  AttenuationError, BindError, BudgetExceeded, KernelError, RestoreError, TransitionError,
  EVENT_KINDS, INTERRUPTED, TRANSITION_TABLE,
} from './types.ts';
import type {
  Artifact, ArtifactMeta, AxisRequirement, AxisValue, BindRequest, Binding, Budgets, Cell,
  CapabilityManifest, CapabilityEvent, CapabilityProvider, ChargeSpec, Checkpoint,
  Grant, GrantSpec, InvocationOutcome, InvocationState, Invocation, InvokeCtx, InvokeOptions,
  KernelApi, KernelEvent, KernelEventKind, KindDefinition, PolicyStage, ProbeReport,
  RestoreResult, ResumeInput, ResumeOptions, SuspensionRecord,
} from './types.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Does a granted right cover a needed right? `invoke:*` covers `invoke:x`. */
function rightCovers(granted: string, needed: string): boolean {
  if (granted === needed) return true;
  return granted.endsWith('*') && needed.startsWith(granted.slice(0, -1));
}

type AxisCheck =
  | { readonly ok: true; readonly chosen: string | boolean }
  | { readonly ok: false; readonly problem: string };

/** One requirement against one manifest axis value. Tier order comes from the
 *  manifest's own ladder — the kernel has no idea what any axis means. */
function checkAxis(r: AxisRequirement, av: AxisValue): AxisCheck {
  if (r.need === 'tier-at-least') {
    if (av.shape !== 'tiered') return { ok: false, problem: `axis '${r.axis}' is not tiered (shape=${av.shape})` };
    const want = av.ladder.indexOf(r.tier);
    const have = av.ladder.indexOf(av.tier);
    if (want < 0) return { ok: false, problem: `axis '${r.axis}': tier '${r.tier}' not on ladder [${av.ladder.join(' < ')}]` };
    if (have < want) return { ok: false, problem: `axis '${r.axis}': requires tier >= '${r.tier}' but manifest offers '${av.tier}' (ladder: ${av.ladder.join(' < ')})` };
    return { ok: true, chosen: av.tier };
  }
  if (r.need === 'one-of') {
    if (av.shape !== 'options') return { ok: false, problem: `axis '${r.axis}' is not an options axis (shape=${av.shape})` };
    const hit = r.anyOf.find((v) => av.offered.includes(v));
    if (hit === undefined) return { ok: false, problem: `axis '${r.axis}': none of [${r.anyOf.join(', ')}] offered (manifest offers [${av.offered.join(', ')}])` };
    return { ok: true, chosen: hit };
  }
  if (r.need === 'enabled') {
    if (av.shape !== 'flag') return { ok: false, problem: `axis '${r.axis}' is not a flag (shape=${av.shape})` };
    if (!av.enabled) return { ok: false, problem: `axis '${r.axis}' is declared but disabled` };
    return { ok: true, chosen: true };
  }
  // 'present'
  if (av.shape === 'tiered') return { ok: true, chosen: av.tier };
  if (av.shape === 'options') return { ok: true, chosen: av.offered[0] ?? '' };
  return { ok: true, chosen: av.enabled };
}

interface NegotiationResult {
  readonly ok: boolean;
  readonly negotiated: Readonly<Record<string, string | boolean>>;
  readonly ignoredAxes: readonly string[];
  readonly absentOptional: readonly string[];
  readonly problems: readonly string[];
}

/** Two-sided intersection. Unknown manifest axes are ignored (and recorded);
 *  a missing REQUIRED axis is a loud failure, never a silent degrade.
 *  A synthetic GREASE requirement keeps the ignore path permanently exercised. */
function negotiateAxes(manifest: CapabilityManifest, requirements: readonly AxisRequirement[], greaseAxis: string): NegotiationResult {
  const negotiated: Record<string, string | boolean> = {};
  const mentioned = new Set<string>();
  const absentOptional: string[] = [];
  const problems: string[] = [];
  const grease: AxisRequirement = { axis: greaseAxis, need: 'present', optional: true };
  for (const r of [...requirements, grease]) {
    mentioned.add(r.axis);
    const av = manifest.axes[r.axis];
    if (av === undefined) {
      if (r.optional === true) { absentOptional.push(r.axis); continue; }
      problems.push(`required axis '${r.axis}' is absent from manifest of '${manifest.identity.id}' (declared axes: [${Object.keys(manifest.axes).join(', ')}])`);
      continue;
    }
    const check = checkAxis(r, av);
    if (check.ok) negotiated[r.axis] = check.chosen;
    else problems.push(check.problem);
  }
  const ignoredAxes = Object.keys(manifest.axes).filter((a) => !mentioned.has(a));
  return { ok: problems.length === 0, negotiated, ignoredAxes, absentOptional, problems };
}

const CHARGE_DIMENSIONS = ['tokens', 'moneyCents', 'invocations'] as const;

// ---------------------------------------------------------------------------
// The Kernel
// ---------------------------------------------------------------------------

export interface KernelOptions {
  readonly journalPath: string;
  readonly clock?: (() => string) | undefined;
  /** Rebuild state from an existing journal instead of starting a fresh one. */
  readonly replay?: boolean | undefined;
}

export class Kernel implements KernelApi {
  private readonly journalPath: string;
  private readonly clock: () => string;
  private readonly events: KernelEvent[] = [];
  private seq = 0;

  private readonly providers = new Map<string, CapabilityProvider>();
  private readonly kinds = new Map<string, KindDefinition>();
  private readonly policyStages: PolicyStage[] = [];
  private readonly grants = new Map<string, Grant>();
  private readonly cells = new Map<string, Cell>();
  private readonly bindings = new Map<string, Binding>();
  private readonly invocations = new Map<string, Invocation>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly idempotency = new Map<string, string>();
  private readonly cellQueues = new Map<string, Promise<unknown>>();
  private readonly counters = new Map<string, number>();

  constructor(opts: KernelOptions) {
    this.journalPath = opts.journalPath;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    if (opts.replay === true) {
      const raw = readFileSync(this.journalPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        const ev = JSON.parse(line) as KernelEvent;
        if (!(EVENT_KINDS as readonly string[]).includes(ev.kind)) {
          throw new KernelError(`journal replay: unknown record '${String(ev.kind)}' at seq ${ev.seq}`);
        }
        this.events.push(ev);
        this.seq = ev.seq;
        Kernel.REPLAY[ev.kind](this, ev);
      }
    } else {
      writeFileSync(this.journalPath, '');
    }
  }

  // -- journal ---------------------------------------------------------------

  private append(partial: {
    kind: KernelEventKind; actorId: string; payload: Record<string, unknown>;
    cellId?: string | undefined; invocationId?: string | undefined;
    correlationId?: string | undefined; causationId?: string | undefined;
    artifactRefs?: readonly string[] | undefined;
  }): KernelEvent {
    this.seq += 1;
    const ev: KernelEvent = {
      id: `ev-${this.seq}`, seq: this.seq, kind: partial.kind, occurredAt: this.clock(),
      cellId: partial.cellId, invocationId: partial.invocationId,
      correlationId: partial.correlationId, causationId: partial.causationId,
      actorId: partial.actorId, artifactRefs: partial.artifactRefs ?? [], payload: partial.payload,
    };
    this.events.push(ev);
    appendFileSync(this.journalPath, JSON.stringify(ev) + '\n');
    return ev;
  }

  journal(): readonly KernelEvent[] { return this.events; }

  /** Replay handlers: a TOTAL table over the closed set of journal record
   *  names. Table dispatch, deliberately — no conditional chains over record
   *  identity anywhere. Payload casts are safe: we only replay our own writes. */
  private static readonly REPLAY: Readonly<Record<KernelEventKind, (k: Kernel, ev: KernelEvent) => void>> = {
    'capability.registered': () => { /* providers are code; re-registered at boot */ },
    'kind.registered': () => { /* definitions are code; re-registered at boot */ },
    'kind.object': () => { /* payload already replayed via artifact.stored */ },
    'cell.created': (k, ev) => {
      const c = ev.payload['cell'] as Cell;
      k.cells.set(c.id, { ...c, live: false });
      k.bumpCounter(c.id);
    },
    'cell.restored': (k, ev) => {
      const cell = k.cells.get(ev.payload['cellId'] as string);
      if (cell) cell.restoredFrom = ev.payload['checkpointId'] as string;
      // liveness is per-instance runtime state: replay never re-arms a cell
    },
    'grant.created': (k, ev) => {
      const g = ev.payload['grant'] as Grant;
      k.grants.set(g.id, { ...g, budgets: { ...g.budgets } });
      k.bumpCounter(g.id);
    },
    'grant.charged': (k, ev) => {
      const g = k.grants.get(ev.payload['grantId'] as string);
      if (g) Object.assign(g.budgets, ev.payload['remaining']); // idempotent: journal carries the post-charge snapshot
    },
    'grant.revoked': (k, ev) => {
      const g = k.grants.get(ev.payload['grantId'] as string);
      if (g) g.revoked = true;
    },
    'binding.created': (k, ev) => {
      const b = ev.payload['binding'] as Binding;
      k.bindings.set(b.id, b);
      k.bumpCounter(b.id);
    },
    'binding.rejected': () => { /* audit trail only */ },
    'policy.decision': () => { /* audit trail only */ },
    'invocation.submitted': (k, ev) => {
      const s = ev.payload['invocation'] as Omit<Invocation, 'state' | 'policyIndex' | 'providerStarted' | 'cancelRequested'>;
      const inv: Invocation = { ...s, state: 'submitted', policyIndex: 0, providerStarted: false, cancelRequested: false };
      k.invocations.set(inv.id, inv);
      k.idempotency.set(inv.idempotencyKey, inv.id);
      k.bumpCounter(inv.id);
    },
    'invocation.transition': (k, ev) => {
      const inv = k.invocations.get(ev.invocationId ?? '');
      if (!inv) return;
      inv.state = ev.payload['to'] as InvocationState;
      inv.suspension = (ev.payload['suspension'] as SuspensionRecord | undefined) ?? undefined;
      if ('output' in ev.payload) inv.output = ev.payload['output'];
      if (ev.payload['outputArtifact'] !== undefined) inv.outputArtifact = ev.payload['outputArtifact'] as string;
      if (ev.payload['error'] !== undefined) inv.error = ev.payload['error'] as string;
      if (ev.payload['grantId'] !== undefined) inv.grantId = ev.payload['grantId'] as string;
    },
    'invocation.progress': () => { /* advisory plane */ },
    'artifact.stored': (k, ev) => {
      const a = ev.payload['artifact'] as Artifact;
      k.artifacts.set(a.hash, a);
    },
    'checkpoint.created': (k, ev) => {
      const cp = ev.payload['checkpoint'] as Checkpoint;
      k.checkpoints.set(cp.id, cp);
      k.bumpCounter(cp.id);
    },
    'probe.completed': () => { /* evidence lives in the CAS */ },
  };

  private bumpCounter(id: string): void {
    const m = /^([a-z]+)-(\d+)$/.exec(id);
    if (!m) return;
    const prefix = m[1] as string; const n = Number(m[2]);
    if (n > (this.counters.get(prefix) ?? 0)) this.counters.set(prefix, n);
  }

  private nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }

  // -- registries ------------------------------------------------------------

  registerCapability(provider: CapabilityProvider): void {
    const id = provider.identity.id;
    if (provider.manifest.identity.id !== id) throw new KernelError(`manifest identity '${provider.manifest.identity.id}' does not match provider identity '${id}'`);
    this.providers.set(id, provider);
    this.append({
      kind: 'capability.registered', actorId: id,
      payload: { identity: provider.identity, axes: Object.keys(provider.manifest.axes) },
    });
  }

  /** Discovery hook (spine §2 'capability discovery'): enumerate registered
   *  manifests, registration order preserved. The minimal hook the graph
   *  prototype needs to resolve axis requirements to providers at runtime. */
  listCapabilities(): readonly CapabilityManifest[] {
    return [...this.providers.values()].map((p) => p.manifest);
  }

  registerKind(def: KindDefinition): void {
    this.kinds.set(def.name, def);
    this.append({ kind: 'kind.registered', actorId: 'kernel', payload: { name: def.name, version: def.version } });
  }

  /** Validate a payload against a registered Kind and store it as an artifact. */
  createKindObject(kindName: string, payload: unknown): string {
    const def = this.kinds.get(kindName);
    if (!def) throw new KernelError(`no registered Kind named '${kindName}'`);
    const problems = def.validate(payload);
    if (problems.length > 0) throw new KernelError(`Kind '${kindName}' validation failed:\n  - ${problems.join('\n  - ')}`);
    const hash = this.storeArtifact(payload, {});
    this.append({ kind: 'kind.object', actorId: 'kernel', artifactRefs: [hash], payload: { kindName, version: def.version, artifact: hash } });
    return hash;
  }

  registerPolicyStage(stage: PolicyStage): void {
    this.policyStages.push(stage); // ordered by registration; not journaled (stages are code/config)
  }

  async probe(capabilityId: string): Promise<ProbeReport | null> {
    const p = this.providers.get(capabilityId);
    if (!p) throw new KernelError(`no provider registered for '${capabilityId}'`);
    if (!p.probe) return null;
    const report = await p.probe({ clock: this.clock });
    const hash = this.storeArtifact(report, { taint: [] });
    this.append({ kind: 'probe.completed', actorId: capabilityId, artifactRefs: [hash], payload: { capabilityId, ok: report.ok } });
    return report;
  }

  // -- grants ----------------------------------------------------------------

  createGrant(spec: GrantSpec): Grant {
    return this.mintGrant(spec, undefined);
  }

  /** Attenuation-on-delegation: child rights/budgets must fit inside the
   *  parent's REMAINING authority; spawnDepth strictly decreases. */
  attenuate(parentGrantId: string, spec: GrantSpec): Grant {
    const parent = this.mustGrant(parentGrantId);
    if (parent.revoked) throw new AttenuationError(`parent grant ${parent.id} is revoked`);
    for (const r of spec.rights) {
      if (!parent.rights.some((pr) => rightCovers(pr, r))) {
        throw new AttenuationError(`right '${r}' is not covered by parent grant ${parent.id} (parent rights: [${parent.rights.join(', ')}])`);
      }
    }
    for (const d of CHARGE_DIMENSIONS) {
      const c = spec.budgets[d]; const p = parent.budgets[d];
      if (c === null && p !== null) throw new AttenuationError(`child ${d} is unlimited but parent ${parent.id} has only ${p} remaining`);
      if (c !== null && p !== null && c > p) throw new AttenuationError(`child ${d}=${c} exceeds parent ${parent.id} remaining ${p}`);
    }
    const cs = spec.budgets.spawnDepth; const ps = parent.budgets.spawnDepth;
    if (ps !== null && (cs === null || cs >= ps)) {
      throw new AttenuationError(`child spawnDepth must be finite and strictly < parent's (${ps}); got ${String(cs)}`);
    }
    return this.mintGrant(spec, parent.id);
  }

  private mintGrant(spec: GrantSpec, parentId: string | undefined): Grant {
    const g: Grant = {
      id: this.nextId('grant'), parentId, rights: [...spec.rights],
      budgets: { ...spec.budgets }, initial: spec.budgets,
      label: spec.label ?? '(unlabeled)', revoked: false, createdAt: this.clock(),
    };
    this.grants.set(g.id, g);
    this.append({ kind: 'grant.created', actorId: 'kernel', payload: { grant: g } });
    return g;
  }

  revoke(grantId: string): void {
    const g = this.mustGrant(grantId);
    g.revoked = true;
    this.append({ kind: 'grant.revoked', actorId: 'kernel', payload: { grantId } });
  }

  getGrant(grantId: string): Grant { return this.mustGrant(grantId); }

  private mustGrant(grantId: string): Grant {
    const g = this.grants.get(grantId);
    if (!g) throw new KernelError(`unknown grant '${grantId}'`);
    return g;
  }

  private lineageOf(grantId: string): Grant[] {
    const chain: Grant[] = [];
    let cur: Grant | undefined = this.mustGrant(grantId);
    while (cur !== undefined && chain.length < 64) {
      chain.push(cur);
      cur = cur.parentId === undefined ? undefined : this.grants.get(cur.parentId);
    }
    return chain;
  }

  /** Charge a grant AND every ancestor at a commit point. Atomic: the whole
   *  lineage is checked before anything is decremented. Every decrement is a
   *  journal record carrying the post-charge snapshot (idempotent replay). */
  private charge(grantId: string, cost: ChargeSpec, invocationId: string | undefined): void {
    const chain = this.lineageOf(grantId);
    const entries = CHARGE_DIMENSIONS
      .map((d) => [d, cost[d] ?? 0] as const)
      .filter(([, v]) => v > 0);
    if (entries.length === 0) return;
    for (const g of chain) {
      if (g.revoked) throw new BudgetExceeded(`grant ${g.id} is revoked`, g.id, 'revoked');
      for (const [d, v] of entries) {
        const rem = g.budgets[d];
        if (rem !== null && rem < v) throw new BudgetExceeded(`grant ${g.id} ('${g.label}') ${d} exhausted: need ${v}, remaining ${rem}`, g.id, d);
      }
    }
    for (const g of chain) {
      for (const [d, v] of entries) {
        const rem = g.budgets[d];
        if (rem !== null) g.budgets[d] = rem - v;
      }
      this.append({
        kind: 'grant.charged', actorId: 'kernel', invocationId,
        payload: { grantId: g.id, invocationId: invocationId ?? null, cost: Object.fromEntries(entries), remaining: { ...g.budgets } },
      });
    }
  }

  // -- cells -----------------------------------------------------------------

  createCell(key: string): Cell {
    const c: Cell = { id: this.nextId('cell'), key, createdAt: this.clock(), live: true, restoredFrom: undefined };
    this.cells.set(c.id, c);
    this.append({ kind: 'cell.created', actorId: 'kernel', cellId: c.id, payload: { cell: { ...c, live: undefined } } });
    return c;
  }

  private mustLiveCell(cellId: string): Cell {
    const cell = this.cells.get(cellId);
    if (!cell) throw new KernelError(`unknown cell '${cellId}'`);
    if (!cell.live) throw new KernelError(`cell '${cellId}' exists in the journal but is not active in this instance — restore(checkpointId) first`);
    return cell;
  }

  /** Single-writer discipline: one turn at a time per cell (promise chain). */
  private enqueue<T>(cellId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.cellQueues.get(cellId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.cellQueues.set(cellId, next.then(() => undefined, () => undefined));
    return next;
  }

  // -- negotiation / binding -------------------------------------------------

  bind(req: BindRequest): Binding {
    const provider = this.providers.get(req.capabilityId);
    if (!provider) {
      this.append({ kind: 'binding.rejected', actorId: 'kernel', payload: { capabilityId: req.capabilityId, problems: ['capability not registered'] } });
      throw new BindError(`bind failed: no capability '${req.capabilityId}' registered`);
    }
    const grant = this.mustGrant(req.grantId);
    if (grant.revoked) throw new BindError(`bind failed: grant ${grant.id} is revoked`);
    const needed = `invoke:${req.capabilityId}`;
    if (!grant.rights.some((r) => rightCovers(r, needed))) {
      this.append({ kind: 'binding.rejected', actorId: 'kernel', payload: { capabilityId: req.capabilityId, problems: [`grant ${grant.id} lacks right '${needed}'`] } });
      throw new BindError(`bind failed: grant ${grant.id} ('${grant.label}') lacks right '${needed}'`);
    }
    const neg = negotiateAxes(provider.manifest, req.requirements, `kyxo.grease/${this.seq + 1}`);
    if (!neg.ok) {
      this.append({ kind: 'binding.rejected', actorId: 'kernel', payload: { capabilityId: req.capabilityId, problems: neg.problems } });
      throw new BindError(`bind to '${req.capabilityId}' failed LOUDLY (the kernel never silently degrades):\n  - ${neg.problems.join('\n  - ')}`);
    }
    for (const stage of this.policyStages.filter((s) => s.phases.includes('bind'))) {
      const d = stage.evaluate({ phase: 'bind', capabilityId: req.capabilityId, manifest: provider.manifest, grant, inputTaint: [] });
      this.append({ kind: 'policy.decision', actorId: `policy:${stage.name}`, payload: { stage: stage.name, phase: 'bind', capabilityId: req.capabilityId, ...d } });
      if (d.decision === 'deny') throw new BindError(`bind to '${req.capabilityId}' denied by policy '${stage.name}': ${d.reason}`);
      if (d.decision === 'suspend') throw new BindError(`policy '${stage.name}' tried to suspend at bind time; unsupported in this prototype`);
    }
    const binding: Binding = {
      id: this.nextId('bind'), capabilityId: req.capabilityId, capabilityVersion: provider.identity.version,
      grantId: req.grantId, negotiated: neg.negotiated, ignoredAxes: neg.ignoredAxes,
      absentOptional: neg.absentOptional,
      policyRoute: this.policyStages.filter((s) => s.phases.includes('invoke')).map((s) => s.name),
      createdAt: this.clock(),
    };
    this.bindings.set(binding.id, binding);
    this.append({ kind: 'binding.created', actorId: 'kernel', payload: { binding } });
    return binding;
  }

  getBinding(bindingId: string): Binding {
    const b = this.bindings.get(bindingId);
    if (!b) throw new KernelError(`unknown binding '${bindingId}'`);
    return b;
  }

  // -- invocation lifecycle --------------------------------------------------

  async invoke(bindingId: string, request: unknown, opts?: InvokeOptions): Promise<InvocationOutcome> {
    const binding = this.getBinding(bindingId);
    const provider = this.providers.get(binding.capabilityId);
    if (!provider) throw new KernelError(`no provider for '${binding.capabilityId}' in this instance`);
    if (opts?.idempotencyKey !== undefined) {
      const seen = this.idempotency.get(opts.idempotencyKey);
      if (seen !== undefined) return this.outcomeOf(this.mustInvocation(seen)); // exactly-once illusion (dedup window = forever, cheat)
    }
    const grant = this.mustGrant(binding.grantId);
    if (grant.revoked) throw new KernelError(`grant ${grant.id} is revoked`);
    const cellId = opts?.cellId ?? this.createCell(`auto:${binding.id}:${this.seq}`).id;
    this.mustLiveCell(cellId);
    const id = this.nextId('inv');
    const causationId = opts?.causationId;
    const correlationId = opts?.correlationId
      ?? (causationId !== undefined ? this.invocations.get(causationId)?.correlationId : undefined)
      ?? id;
    const inv: Invocation = {
      id, bindingId, capabilityId: binding.capabilityId, cellId, grantId: binding.grantId,
      request, idempotencyKey: opts?.idempotencyKey ?? id, correlationId, causationId,
      inputArtifacts: opts?.inputArtifacts ?? [], state: 'submitted',
      suspension: undefined, output: undefined, outputArtifact: undefined, error: undefined,
      policyIndex: 0, providerStarted: false, cancelRequested: false, submittedAt: this.clock(),
    };
    this.invocations.set(id, inv);
    this.idempotency.set(inv.idempotencyKey, id);
    this.append({
      kind: 'invocation.submitted', actorId: opts?.actorId ?? 'kernel', cellId, invocationId: id,
      correlationId, causationId, payload: {
        invocation: {
          id, bindingId, capabilityId: inv.capabilityId, cellId, grantId: inv.grantId, request,
          idempotencyKey: inv.idempotencyKey, correlationId, causationId,
          inputArtifacts: inv.inputArtifacts, submittedAt: inv.submittedAt,
        },
      },
    });
    return this.enqueue(cellId, () => this.driveFresh(inv));
  }

  async resume(invocationId: string, payload: unknown, opts?: ResumeOptions): Promise<InvocationOutcome> {
    const inv = this.mustInvocation(invocationId);
    if (!INTERRUPTED.includes(inv.state)) throw new KernelError(`invocation ${inv.id} is '${inv.state}', not an interrupted state — nothing to resume`);
    const s = inv.suspension;
    if (!s) throw new KernelError(`invocation ${inv.id} has no suspension record`);
    const cell = this.mustLiveCell(inv.cellId);
    if (s.origin === 'policy') {
      const approved = payload !== null && (payload as { approved?: boolean }).approved === true;
      this.append({ kind: 'policy.decision', actorId: 'kernel', invocationId: inv.id, cellId: cell.id, payload: { stage: '(resume)', resolution: payload, approved } });
      if (!approved) {
        this.transition(inv, 'rejected', { reason: 'policy suspension resumed with a denial' });
        return this.outcomeOf(inv);
      }
      inv.policyIndex = (s.policyIndex ?? 0) + 1; // never re-run earlier stages
      inv.suspension = undefined;
      return this.enqueue(cell.id, () => this.driveFresh(inv));
    }
    if (s.origin === 'kernel' && opts?.grantId !== undefined) {
      // re-grant verb: budget-exceeded resume under a fresh grant (spine gap; see findings)
      const fresh = this.mustGrant(opts.grantId);
      const needed = `invoke:${inv.capabilityId}`;
      if (!fresh.rights.some((r) => rightCovers(r, needed))) throw new KernelError(`replacement grant ${fresh.id} lacks right '${needed}'`);
      inv.grantId = fresh.id;
    }
    return this.enqueue(cell.id, () => this.enterWorkingAndRun(inv, { input: payload, suspension: s }));
  }

  cancel(invocationId: string, reason: string): void {
    const inv = this.mustInvocation(invocationId);
    if (TRANSITION_TABLE[inv.state].length === 0) throw new KernelError(`invocation ${inv.id} is already terminal ('${inv.state}')`);
    if (inv.state === 'working') { inv.cancelRequested = true; return; } // honored at the next commit point
    this.transition(inv, 'canceled', { reason });
  }

  getInvocation(invocationId: string): Invocation { return this.mustInvocation(invocationId); }

  private mustInvocation(id: string): Invocation {
    const inv = this.invocations.get(id);
    if (!inv) throw new KernelError(`unknown invocation '${id}'`);
    return inv;
  }

  /** Fresh entry (or policy-resume re-entry): policy pipeline, then provider. */
  private async driveFresh(inv: Invocation): Promise<InvocationOutcome> {
    const verdict = this.runPolicyRoute(inv);
    if (verdict !== 'clear') return this.outcomeOf(inv);
    return this.enterWorkingAndRun(inv, undefined);
  }

  private runPolicyRoute(inv: Invocation): 'clear' | 'rejected' | 'suspended' {
    const binding = this.getBinding(inv.bindingId);
    const provider = this.providers.get(inv.capabilityId);
    if (!provider) throw new KernelError(`no provider for '${inv.capabilityId}'`);
    while (inv.policyIndex < binding.policyRoute.length) {
      const name = binding.policyRoute[inv.policyIndex] as string;
      const stage = this.policyStages.find((st) => st.name === name);
      if (!stage) throw new KernelError(`policy stage '${name}' sealed into binding ${binding.id} is not registered in this instance`);
      const d = stage.evaluate({
        phase: 'invoke', capabilityId: inv.capabilityId, manifest: provider.manifest,
        grant: this.mustGrant(inv.grantId), request: inv.request, invocationId: inv.id,
        inputTaint: this.taintOf(inv),
      });
      this.append({ kind: 'policy.decision', actorId: `policy:${stage.name}`, invocationId: inv.id, cellId: inv.cellId, payload: { stage: stage.name, phase: 'invoke', ...d } });
      if (d.decision === 'deny') {
        this.transition(inv, 'rejected', { reason: `policy '${stage.name}' denied (non-bypassable): ${d.reason}` });
        return 'rejected';
      }
      if (d.decision === 'suspend') {
        this.transition(inv, 'approval-required', {
          suspension: { reason: 'approval-required', origin: 'policy', payload: d.payload, at: this.clock(), policyIndex: inv.policyIndex },
        });
        return 'suspended';
      }
      inv.policyIndex += 1;
    }
    return 'clear';
  }

  /** Admission charge (one invocation unit) at the commit point, then run. */
  private async enterWorkingAndRun(inv: Invocation, resume: ResumeInput | undefined): Promise<InvocationOutcome> {
    try {
      this.charge(inv.grantId, { invocations: 1 }, inv.id);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        this.transition(inv, 'budget-exceeded', {
          suspension: { reason: 'budget-exceeded', origin: 'kernel', payload: { grantId: err.grantId, dimension: err.dimension, message: err.message }, at: this.clock() },
        });
        return this.outcomeOf(inv);
      }
      throw err;
    }
    this.transition(inv, 'working', { grantId: inv.grantId });
    return this.runProvider(inv, resume);
  }

  private async runProvider(inv: Invocation, resume: ResumeInput | undefined): Promise<InvocationOutcome> {
    const provider = this.providers.get(inv.capabilityId);
    if (!provider) throw new KernelError(`no provider for '${inv.capabilityId}'`);
    inv.providerStarted = true;
    const ctx: InvokeCtx = {
      invocationId: inv.id, cellId: inv.cellId, grantId: inv.grantId,
      clock: this.clock, resume, kernel: this,
    };
    try {
      for await (const ev of provider.invoke(inv.request, ctx)) {
        if (inv.cancelRequested) {
          this.transition(inv, 'canceled', { reason: 'cancel requested; honored at commit point' });
          return this.outcomeOf(inv);
        }
        const stop = this.applyCapabilityEvent(inv, ev);
        if (stop) break;
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        this.transition(inv, 'budget-exceeded', {
          suspension: { reason: 'budget-exceeded', origin: 'kernel', payload: { grantId: err.grantId, dimension: err.dimension, message: err.message }, at: this.clock() },
        });
        return this.outcomeOf(inv);
      }
      this.transition(inv, 'failed', { error: err instanceof Error ? err.message : String(err) });
      return this.outcomeOf(inv);
    }
    if (inv.state === 'working') {
      this.transition(inv, 'failed', { error: 'provider event stream ended without result/fail/suspend — refusing to guess' });
    }
    return this.outcomeOf(inv);
  }

  /** Uniform consumption of the closed provider-event protocol. Each yield is
   *  a commit point (journal + charge). Returns true when driving must stop.
   *  This if-chain discriminates PROTOCOL OPCODES, never capability identity. */
  private applyCapabilityEvent(inv: Invocation, ev: CapabilityEvent): boolean {
    if (ev.op === 'progress') {
      this.append({ kind: 'invocation.progress', actorId: inv.capabilityId, cellId: inv.cellId, invocationId: inv.id, correlationId: inv.correlationId, payload: { note: ev.note, data: ev.data ?? null } });
      return false;
    }
    if (ev.op === 'charge') {
      this.charge(inv.grantId, ev.cost, inv.id); // throws BudgetExceeded upward
      return false;
    }
    if (ev.op === 'artifact') {
      this.storeArtifact(ev.content, {
        producedBy: inv.id, inputs: inv.inputArtifacts,
        taint: [...new Set([...(ev.taint ?? []), ...this.taintOf(inv)])],
      });
      return false;
    }
    if (ev.op === 'suspend') {
      this.transition(inv, ev.reason, {
        suspension: { reason: ev.reason, origin: 'provider', payload: ev.payload, at: this.clock() },
      });
      return true;
    }
    if (ev.op === 'result') {
      const hash = this.storeArtifact(ev.output ?? null, {
        producedBy: inv.id, inputs: inv.inputArtifacts, taint: this.taintOf(inv),
      });
      this.transition(inv, 'completed', { output: ev.output, outputArtifact: hash, artifactRefs: [hash] });
      return true;
    }
    // 'fail'
    this.transition(inv, 'failed', { error: ev.error });
    return true;
  }

  private transition(inv: Invocation, to: InvocationState, extra: {
    reason?: string; suspension?: SuspensionRecord; output?: unknown;
    outputArtifact?: string; error?: string; grantId?: string; artifactRefs?: readonly string[];
  }): void {
    const from = inv.state;
    if (!TRANSITION_TABLE[from].includes(to)) {
      throw new TransitionError(`illegal lifecycle transition '${from}' -> '${to}' on invocation ${inv.id} (closed algebra; see TRANSITION_TABLE)`);
    }
    inv.state = to;
    inv.suspension = extra.suspension;
    if (extra.output !== undefined) inv.output = extra.output;
    if (extra.outputArtifact !== undefined) inv.outputArtifact = extra.outputArtifact;
    if (extra.error !== undefined) inv.error = extra.error;
    const payload: Record<string, unknown> = { from, to };
    if (extra.reason !== undefined) payload['reason'] = extra.reason;
    if (extra.suspension !== undefined) payload['suspension'] = extra.suspension;
    if (extra.output !== undefined) payload['output'] = extra.output;
    if (extra.outputArtifact !== undefined) payload['outputArtifact'] = extra.outputArtifact;
    if (extra.error !== undefined) payload['error'] = extra.error;
    if (extra.grantId !== undefined) payload['grantId'] = extra.grantId;
    this.append({
      kind: 'invocation.transition', actorId: 'kernel', cellId: inv.cellId, invocationId: inv.id,
      correlationId: inv.correlationId, causationId: inv.causationId,
      artifactRefs: extra.artifactRefs ?? [], payload,
    });
  }

  private outcomeOf(inv: Invocation): InvocationOutcome {
    return {
      invocationId: inv.id, state: inv.state, output: inv.output,
      outputArtifact: inv.outputArtifact, suspension: inv.suspension, error: inv.error,
    };
  }

  private taintOf(inv: Invocation): readonly string[] {
    const labels = new Set<string>();
    for (const h of inv.inputArtifacts) {
      for (const t of this.artifacts.get(h)?.taint ?? []) labels.add(t);
    }
    return [...labels];
  }

  // -- artifacts (CAS) -------------------------------------------------------

  storeArtifact(content: unknown, meta?: ArtifactMeta): string {
    const body = JSON.stringify(content) ?? 'null';
    // CHEAT: truncated, non-canonical hash — enough to prove content addressing
    const hash = 'sha256:' + createHash('sha256').update(body).digest('hex').slice(0, 16);
    if (this.artifacts.has(hash)) return hash; // dedup; first writer's provenance wins (cheat)
    const artifact: Artifact = {
      hash, content,
      provenance: { producedBy: meta?.producedBy, inputs: meta?.inputs ?? [] },
      taint: [...(meta?.taint ?? [])], storedAt: this.clock(),
    };
    this.artifacts.set(hash, artifact);
    this.append({
      kind: 'artifact.stored', actorId: meta?.producedBy ?? 'kernel',
      invocationId: meta?.producedBy, artifactRefs: [hash], payload: { artifact },
    });
    return hash;
  }

  getArtifact(hash: string): Artifact {
    const a = this.artifacts.get(hash);
    if (!a) throw new KernelError(`no artifact '${hash}' in the CAS`);
    return a;
  }

  // -- checkpoint / restore --------------------------------------------------

  checkpoint(cellId: string): Checkpoint {
    this.mustLiveCell(cellId);
    const snaps = [...this.invocations.values()]
      .filter((i) => i.cellId === cellId)
      .map((i) => ({ invocationId: i.id, state: i.state, suspension: i.suspension }));
    const cp: Checkpoint = {
      id: this.nextId('cp'), cellId, journalSeq: this.seq,
      invocations: snaps,
      pending: snaps.filter((s) => INTERRUPTED.includes(s.state)).map((s) => s.invocationId),
      createdAt: this.clock(),
    };
    this.checkpoints.set(cp.id, cp);
    this.append({ kind: 'checkpoint.created', actorId: 'kernel', cellId, payload: { checkpoint: cp } });
    return cp;
  }

  /** Re-arm a replayed cell from a checkpoint. CHEAT: validates the replayed-
   *  to-tip state against the snapshot instead of rewinding to the cut;
   *  divergence past the checkpoint is an error, not a fork. */
  restore(checkpointId: string): RestoreResult {
    const cp = this.checkpoints.get(checkpointId);
    if (!cp) throw new RestoreError(`unknown checkpoint '${checkpointId}'`);
    const cell = this.cells.get(cp.cellId);
    if (!cell) throw new RestoreError(`checkpoint ${cp.id} names cell '${cp.cellId}' which is absent from the journal`);
    for (const snap of cp.invocations) {
      const inv = this.invocations.get(snap.invocationId);
      if (!inv) throw new RestoreError(`checkpoint ${cp.id}: invocation ${snap.invocationId} missing after replay`);
      if (inv.state !== snap.state) {
        throw new RestoreError(`checkpoint ${cp.id}: invocation ${inv.id} replayed to '${inv.state}' but checkpoint recorded '${snap.state}' — journal advanced past the cut and fork-from-checkpoint is not implemented in this prototype`);
      }
    }
    cell.live = true;
    cell.restoredFrom = cp.id;
    this.append({ kind: 'cell.restored', actorId: 'kernel', cellId: cp.cellId, payload: { cellId: cp.cellId, checkpointId: cp.id } });
    return { cellId: cp.cellId, pending: [...cp.pending] };
  }
}
