/**
 * Semantic effect identity — the S1b answer to "is this the same real-world operation?"
 *
 * THE PROBLEM S1 LEFT OPEN.
 *
 * S1 derived the effect key as `sha({capabilityId, step, request})`, hashing the WHOLE
 * request. Six independent reviewers converged on the same conclusion: that is unsafe,
 * and unsafe in the direction that costs money. Every one of these ordinary developer
 * behaviours produced a second real charge, with a green test suite:
 *
 *   - a fresh idempotency nonce per attempt (the habit Stripe's own docs teach)
 *   - a `requestedAt` / `createdAt` timestamp
 *   - a regenerated UUID, trace id or correlation id
 *   - a retried job or a re-run workflow
 *   - an array field whose order varies (a set serialised from a Map, or DB row order)
 *   - a forgotten `step` (which defaulted to the string `'anon'`)
 *
 * The failure is not that the hash was wrong. It is that the runtime was asking the wrong
 * question. `sha(request)` answers "are these the same BYTES?" The question that decides
 * whether to charge a card is "are these the same OPERATION?" Those coincide only when a
 * request contains nothing incidental, which is never.
 *
 * THREE IDENTITIES, DELIBERATELY DISTINCT.
 *
 *   Invocation identity   `inv_000123` — this attempt. Fresh every time, including retries.
 *                         Names a row in the journal, never a fact about the world.
 *
 *   Request identity      `sha(canonical(request))` — these exact bytes. Useful for
 *                         debugging and for delivery dedup; NEVER used to decide whether
 *                         an irreversible effect may proceed.
 *
 *   Semantic effect       what this file computes. Names the real-world operation:
 *   identity              "charge invoice INV-42 for 100 USD". Two attempts carrying
 *                         different nonces, timestamps and trace ids share it. Two
 *                         genuinely different charges do not.
 *
 * WHERE IT COMES FROM.
 *
 * The kernel cannot infer which request fields are semantic — that is domain knowledge.
 * So it does not guess. Identity comes from exactly one of two places, both explicit:
 *
 *   1. the CALLER supplies an `idempotencyKey` (business identity: an invoice number, an
 *      order id, a job id — something stable across retries by construction), or
 *   2. the CAPABILITY declares an identity SCHEMA in its manifest, naming the semantic
 *      fields, and the kernel projects the request through it.
 *
 * If neither exists and the effect class is irreversible or compensatable, the kernel
 * REFUSES THE INVOCATION. It does not fall back to hashing the request, because that
 * fallback is the defect: it is silent, it looks like it works, and it fails only in
 * production and only with money.
 *
 * Convenience does not get to become a double-charge risk by default. Making it one
 * requires the explicit, journaled, rights-gated escape hatch in `s1b-escape.ts`.
 */

import { canonical, sha, NonCanonicalValueError } from './storage.ts';
import type { EffectClass, EffectKey } from './types.ts';
import { requiresExclusiveClaim } from './s1-types.ts';

/**
 * The identity SCHEME is versioned independently of the record format.
 *
 * A format revision must be able to change how records are laid out WITHOUT changing what
 * counts as the same effect. If the two shared a version, every format upgrade would
 * silently re-identify every effect in history — the migration double-charge that PART 8
 * exists to prevent. Identity is persisted with its scheme id, and a fold never recomputes
 * an identity it can read.
 */
export const IDENTITY_SCHEME = 'kyxo.effect-identity/1';

export class EffectIdentityError extends Error {}

/**
 * How a capability declares which parts of a request are semantic.
 *
 * `fields` are JSON pointer-ish paths into the request. Everything not named is
 * INCIDENTAL and cannot affect identity — which is the whole point: a nonce is not
 * excluded by a blocklist (blocklists are always incomplete), it is excluded because it
 * was never on the allowlist.
 */
export interface EffectIdentitySchema {
  /** Stable name for the operation, e.g. `payments.charge`. Not the capability id. */
  readonly operation: string;
  /** Allowlisted semantic paths, e.g. ['invoiceId', 'amount.value', 'amount.currency']. */
  readonly fields: readonly string[];
  /**
   * Optional namespace separating tenants or environments that must never share identity
   * even when their business ids collide.
   */
  readonly namespace?: string | undefined;
}

/** What the kernel resolved, and how — journaled so a reader never has to recompute it. */
export interface ResolvedEffectIdentity {
  readonly scheme: string;
  readonly key: EffectKey;
  /** `caller-idempotency-key` | `capability-schema` | `unsafe-request-hash` */
  readonly source: 'caller-idempotency-key' | 'capability-schema' | 'unsafe-request-hash';
  readonly operation: string;
  readonly namespace: string;
  /** The projected semantic values, for audit. Incidental fields never appear here. */
  readonly semantics: Readonly<Record<string, unknown>>;
}

/** Read `a.b.c` out of a plain object. Returns a sentinel when the path is absent. */
const ABSENT = Symbol('absent');
/** Serialisable marker for "this semantic field was not present". Stable across versions. */
const ABSENT_MARKER = '\u0000kyxo:absent';
function pluck(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return ABSENT;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return ABSENT;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export interface IdentityInputs {
  readonly capabilityId: string;
  readonly effectClass: EffectClass;
  readonly request: unknown;
  readonly schema?: EffectIdentitySchema | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly namespace?: string | undefined;
  /** Set only by the journaled escape hatch. Never a plain option on the happy path. */
  readonly unsafeAllowRequestHash?: boolean | undefined;
  /** Deliberately override a capability's declared identity with the caller's key. */
  readonly overrideCapabilityIdentity?: boolean | undefined;
  /**
   * The caller's workflow step. Participates in identity ONLY on the fallback path, where
   * nobody has declared what the operation is. Under a schema or an idempotencyKey it is
   * deliberately ignored: identity belongs to whoever declared it, and letting an
   * incidental step silently split a declared identity would reintroduce the S1 defect.
   */
  readonly step?: string | undefined;
}

/**
 * Resolve the semantic effect identity, or refuse.
 *
 * Precedence is deliberate: a caller-supplied business key beats a capability schema.
 * The caller knows the business identity ("invoice INV-42"); the capability only knows
 * the shape of its own arguments. When the caller says "this is that operation", that is
 * more authoritative than any projection of the bytes.
 */
export function resolveEffectIdentity(input: IdentityInputs): ResolvedEffectIdentity {
  const namespace = input.namespace ?? input.schema?.namespace ?? 'default';
  const exclusive = requiresExclusiveClaim(input.effectClass);

  // 1. Caller-supplied business identity — but ONLY where the capability has not
  //    declared one, or where the caller explicitly overrides.
  //
  //    S1b's first draft gave the caller key precedence unconditionally. An adversarial
  //    SDK review broke it in the most ordinary way imaginable: a developer following
  //    every payments tutorial ever written passed `idempotencyKey: randomUUID()` and got
  //    three charges. The wave exists to stop a fresh nonce becoming a fresh effect, and
  //    the option NAMED FOR THAT PROBLEM had reintroduced it (docs/30 F-40).
  //
  //    The precedence was backwards. A capability's identity schema is an audited artifact
  //    that ships with the capability; a call-site string is neither. A declaration cannot
  //    be silently overridden by a value nobody reviewed — overriding it is a deliberate
  //    act, and it has to look like one.
  const schemaDeclared = input.schema !== undefined;
  const mayUseCallerKey = input.idempotencyKey !== undefined
    && (!schemaDeclared || input.overrideCapabilityIdentity === true);

  if (schemaDeclared && input.idempotencyKey !== undefined && input.overrideCapabilityIdentity !== true) {
    throw new EffectIdentityError(
      `${input.capabilityId} declares an identity schema (operation '${input.schema!.operation}'), ` +
      'so a caller-supplied idempotencyKey would override an audited declaration. ' +
      'If that is intended — a deliberate re-bill, or a business key the capability cannot ' +
      'see — pass overrideCapabilityIdentity: true. If you were reaching for a per-attempt ' +
      'nonce, do not: the schema already makes retries the same effect.',
    );
  }

  if (mayUseCallerKey) {
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
      throw new EffectIdentityError('idempotencyKey must be a non-empty string');
    }
    const operation = input.schema?.operation ?? input.capabilityId;
    return {
      scheme: IDENTITY_SCHEME,
      key: sha({ scheme: IDENTITY_SCHEME, namespace, operation, idempotencyKey: input.idempotencyKey }) as EffectKey,
      source: 'caller-idempotency-key',
      operation,
      namespace,
      semantics: Object.freeze({ idempotencyKey: input.idempotencyKey }),
    };
  }

  // 2. Capability-declared semantic projection.
  if (input.schema !== undefined) {
    const schema = input.schema;
    if (schema.fields.length === 0) {
      throw new EffectIdentityError(
        `capability ${input.capabilityId} declares an identity schema with no fields; ` +
        'an operation whose identity depends on nothing is the same operation every time',
      );
    }
    const semantics: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const path of [...schema.fields].sort()) {
      const v = pluck(input.request, path);
      if (v === ABSENT) { missing.push(path); continue; }
      try {
        canonical(v);                       // reject Date/Map/class instances here, not at hash time
      } catch (err) {
        if (err instanceof NonCanonicalValueError) {
          throw new EffectIdentityError(
            `identity field '${path}' of ${input.capabilityId} is not canonicalisable: ${err.message}`,
          );
        }
        throw err;
      }
      semantics[path] = v;
    }
    // An ABSENT field is recorded as absent, deterministically — not as an error and not
    // by omission. Requiring every field would make optional semantic fields impossible
    // ("charge with no currency" is a legitimate, DIFFERENT operation from "charge with
    // one"); omitting them from the projection instead would make `{a:1}` and `{a:1,b:2}`
    // collide. A stable sentinel keeps absence meaningful and identity total.
    for (const path of missing) semantics[path] = ABSENT_MARKER;

    if (missing.length === schema.fields.length) {
      // Nothing the schema names is present. The schema does not describe this request at
      // all, so any identity derived from it would be the same for every such request —
      // one shared key for unrelated operations. That is a collision, not an identity.
      throw new EffectIdentityError(
        `request to ${input.capabilityId} carries none of its identity fields ` +
        `(${schema.fields.join(', ')}); the schema does not describe this request`,
      );
    }
    return {
      scheme: IDENTITY_SCHEME,
      key: sha({ scheme: IDENTITY_SCHEME, namespace, operation: schema.operation, semantics }) as EffectKey,
      source: 'capability-schema',
      operation: schema.operation,
      namespace,
      semantics: Object.freeze(semantics),
    };
  }

  // 3. Neither. For a repeatable class this is fine; for an irreversible one it is the
  //    S1 defect, and it is refused rather than silently reintroduced.
  if (exclusive && input.unsafeAllowRequestHash !== true) {
    throw new EffectIdentityError(
      `${input.capabilityId} declares effect class '${input.effectClass}' but no effect identity. ` +
      'An irreversible effect needs to say what makes it the same operation: pass an ' +
      'idempotencyKey, or declare identity.fields in the capability manifest. ' +
      'Hashing the whole request is NOT the default, because a nonce or a timestamp in it ' +
      'would silently make every retry a new charge.',
    );
  }

  const operation = input.capabilityId;
  return {
    scheme: IDENTITY_SCHEME,
    key: sha({
      scheme: IDENTITY_SCHEME, namespace, operation,
      step: input.step ?? null, request: input.request,
    }) as EffectKey,
    source: 'unsafe-request-hash',
    operation,
    namespace,
    semantics: Object.freeze({}),
  };
}

/**
 * Recompute an identity from a persisted record, WITHOUT re-deriving it.
 *
 * A migration must never change what an effect is. The recorded key is authoritative
 * forever; this exists so a reader can confirm a record's identity is self-consistent
 * under the scheme it was written with, and refuse a record written under a scheme it
 * does not implement — rather than silently re-identifying it under the current one.
 */
export function verifyRecordedIdentity(rec: ResolvedEffectIdentity): boolean {
  if (rec.scheme !== IDENTITY_SCHEME) return false;   // unknown scheme ⇒ caller must fail closed
  if (rec.source === 'caller-idempotency-key') {
    const k = rec.semantics['idempotencyKey'];
    if (typeof k !== 'string') return false;
    return rec.key === sha({
      scheme: rec.scheme, namespace: rec.namespace, operation: rec.operation, idempotencyKey: k,
    });
  }
  if (rec.source === 'capability-schema') {
    return rec.key === sha({
      scheme: rec.scheme, namespace: rec.namespace, operation: rec.operation, semantics: rec.semantics,
    });
  }
  // A request-hash identity cannot be re-verified from the projection, because there is
  // none. That asymmetry is itself an argument against the escape hatch.
  return true;
}

/** Does this reader implement the scheme a record was written under? */
export function schemeSupported(scheme: string): boolean {
  return scheme === IDENTITY_SCHEME;
}
