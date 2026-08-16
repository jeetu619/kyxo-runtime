/**
 * plan-kind.ts — the Plan Kind: a registered userland type (kernel object 9,
 * the CRD move). The kernel stores and schema-validates Plan objects but owns
 * ZERO plan semantics — topology, edge conditions, join barriers, and the
 * mutation rules all live here in userland and in the strategy that consumes
 * them. Edges do not exist at kernel runtime (the LangGraph lesson): the
 * kernel only ever sees bindings, invocations, and artifacts.
 *
 * THE RULE THIS FILE PROVES: plan nodes carry CAPABILITY REQUIREMENTS (axis
 * expressions, negotiated at execution time) — never provider ids. A plan is
 * portable across any registry that can satisfy its requirements.
 */
import type { AxisRequirement, KindDefinition } from '../kernel/types.ts';

export const PLAN_KIND = 'dev.kyxo.graph/Plan';
export const PLAN_KIND_VERSION = 'v1';

/** Where one named input of a node's request comes from. */
export type InputSource =
  | { readonly from: 'objective' }
  | { readonly from: 'const'; readonly value: unknown }
  | { readonly from: 'node'; readonly node: string; readonly path?: string | undefined }
  /** Reference into the CAS. The hash is also fed to the invocation as an
   *  input artifact, so provenance/taint propagate structurally. */
  | { readonly from: 'artifact'; readonly hash: string };

export type InputMapping = Readonly<Record<string, InputSource>>;

/** Optional edge condition, evaluated on the source node's output. */
export interface EdgeCondition { readonly path: string; readonly equals: unknown }

export interface PlanEdge {
  readonly from: string;
  readonly to: string;
  readonly when?: EdgeCondition | undefined;
}

export interface PlanNode {
  readonly id: string;
  /** Capability REQUIREMENTS (typed axis expressions) — never a provider id. */
  readonly requires: readonly AxisRequirement[];
  readonly input: InputMapping;
  /** Join barrier declaration. Mandatory for nodes with >1 incoming edge. */
  readonly join?: { readonly policy: 'all' } | undefined;
}

export interface Plan {
  readonly planId: string;
  /** Monotonic plan version; every version is its own immutable artifact. */
  readonly version: number;
  readonly objective: string;
  /** Artifact hash of the predecessor plan version (required for version>1). */
  readonly basedOn?: string | undefined;
  /** Artifact hashes of the Evidence that caused this mutation (version>1). */
  readonly becauseOf?: readonly string[] | undefined;
  /** The verification gate: id of the node whose output carries the verdict. */
  readonly gate: string;
  readonly nodes: readonly PlanNode[];
  readonly edges: readonly PlanEdge[];
}

const NEEDS: readonly string[] = ['tier-at-least', 'one-of', 'enabled', 'present'];

export function validatePlan(payload: unknown): readonly string[] {
  const errs: string[] = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return ['plan must be an object'];
  const p = payload as Partial<Plan>;
  if (typeof p.planId !== 'string' || p.planId === '') errs.push('planId: non-empty string required');
  if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1) errs.push('version: integer >= 1 required');
  if (typeof p.objective !== 'string' || p.objective === '') errs.push('objective: non-empty string required');
  const nodes = (Array.isArray(p.nodes) ? p.nodes : []) as readonly PlanNode[];
  if (!Array.isArray(p.nodes) || nodes.length === 0) errs.push('nodes: non-empty array required');
  const edges = (Array.isArray(p.edges) ? p.edges : []) as readonly PlanEdge[];
  if (!Array.isArray(p.edges)) errs.push('edges: array required');

  const ids = new Set<string>();
  for (const n of nodes) {
    if (typeof n?.id !== 'string' || n.id === '') { errs.push('node: non-empty id required'); continue; }
    if (ids.has(n.id)) errs.push(`node '${n.id}': duplicate id`);
    ids.add(n.id);
    if (!Array.isArray(n.requires) || n.requires.length === 0) {
      errs.push(`node '${n.id}': requires must be a non-empty list of capability requirements (a node NEVER names a provider)`);
    } else {
      for (const r of n.requires) {
        if (typeof r?.axis !== 'string' || r.axis === '' || !NEEDS.includes((r as { need?: string }).need ?? '')) {
          errs.push(`node '${n.id}': malformed requirement ${JSON.stringify(r)}`);
        }
      }
    }
    if (n.input === null || typeof n.input !== 'object') errs.push(`node '${n.id}': input mapping must be an object`);
    if (n.join !== undefined && (n.join as { policy?: unknown }).policy !== 'all') {
      errs.push(`node '${n.id}': unsupported join policy '${String((n.join as { policy?: unknown }).policy)}' (schema ${PLAN_KIND_VERSION} supports only 'all')`);
    }
  }

  const indegree = new Map<string, number>();
  for (const e of edges) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string') { errs.push(`edge: from/to must be node ids (${JSON.stringify(e)})`); continue; }
    if (!ids.has(e.from)) errs.push(`edge ${e.from}->${e.to}: unknown source node '${e.from}'`);
    if (!ids.has(e.to)) errs.push(`edge ${e.from}->${e.to}: unknown target node '${e.to}'`);
    if (e.from === e.to) errs.push(`edge ${e.from}->${e.to}: self-edge`);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    if (e.when !== undefined && (typeof e.when.path !== 'string' || e.when.path === '')) {
      errs.push(`edge ${e.from}->${e.to}: condition needs a non-empty path`);
    }
  }

  for (const n of nodes) {
    if (typeof n?.id !== 'string' || n.id === '') continue;
    const deg = indegree.get(n.id) ?? 0;
    if (deg > 1 && n.join === undefined) errs.push(`node '${n.id}': ${deg} incoming edges but no join declaration — barriers must be explicit`);
    if (n.join !== undefined && deg < 2) errs.push(`node '${n.id}': declared join but has only ${deg} incoming edge(s)`);
    if (n.input !== null && typeof n.input === 'object') {
      for (const [key, src] of Object.entries(n.input as InputMapping)) {
        if (src?.from === 'node') {
          if (!ids.has(src.node)) errs.push(`node '${n.id}': input '${key}' references unknown node '${src.node}'`);
          else if (!edges.some((e) => e?.from === src.node && e?.to === n.id)) {
            errs.push(`node '${n.id}': input '${key}' reads node '${src.node}' without a connecting edge — dataflow must follow the graph`);
          }
        }
        if (src?.from === 'artifact' && (typeof src.hash !== 'string' || src.hash === '')) {
          errs.push(`node '${n.id}': input '${key}' artifact source needs a hash`);
        }
      }
    }
  }

  if (typeof p.gate !== 'string' || !ids.has(p.gate)) errs.push(`gate: must name a plan node (got '${String(p.gate)}')`);
  else if (edges.some((e) => e?.from === p.gate)) errs.push(`gate '${p.gate}' must be terminal (no outgoing edges)`);

  // Acyclicity (Kahn) — only meaningful once the structure above is sound.
  if (errs.length === 0) {
    const remaining = new Map<string, number>();
    for (const n of nodes) remaining.set(n.id, 0);
    for (const e of edges) remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
    const queue = [...remaining.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let seen = 0;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      seen += 1;
      for (const e of edges) {
        if (e.from !== id) continue;
        const d = (remaining.get(e.to) ?? 0) - 1;
        remaining.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    if (seen !== nodes.length) errs.push('plan graph contains a cycle — plans must be DAGs');
  }

  if (typeof p.version === 'number' && p.version > 1) {
    if (typeof p.basedOn !== 'string' || p.basedOn === '') errs.push(`version ${p.version}: basedOn (predecessor plan artifact hash) required`);
    if (!Array.isArray(p.becauseOf) || p.becauseOf.length === 0) {
      errs.push(`version ${p.version}: becauseOf (evidence artifact hashes) required — mutations without evidence are forbidden`);
    }
  }
  return errs;
}

export const planKind: KindDefinition = {
  name: PLAN_KIND,
  version: PLAN_KIND_VERSION,
  validate: validatePlan,
};
