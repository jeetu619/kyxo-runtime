/**
 * Reader compatibility, must-understand semantics, and schema evolution.
 *
 * WHY THIS IS A FREEZE BLOCKER AND NOT A BACKLOG ITEM.
 *
 * Doc 25 §6 argued that per-kind versioning and an upcaster registry were "additive …
 * not freeze blockers on their own." The event-sourcing reviewer overturned that with a
 * reproduction, and the argument is simple enough that it should have been obvious:
 *
 *   A revision `2027-01-01` renames `effect.landed` to `world.landed` and re-signs. Every
 *   record verifies. The chain is intact. Today's fold meets `world.landed`, finds no case
 *   for it, and — by the "unknown kinds advance the cursor without changing semantics"
 *   rule that S1 offered as EVIDENCE OF SAFETY — treats it as a no-op. The landing
 *   vanishes. `hasLanded` is false. Protection never engages. The card is charged a second
 *   time, with every invariant green.
 *
 * Forward tolerance and safety are in direct conflict, and S1 resolved the conflict in
 * favour of tolerance by default. That is backwards for anything that protects money.
 *
 * The reason it cannot wait: a must-understand bit added in revision R+1 tells a reader
 * NOTHING about a record written under revision R. The bit has to be in the record from
 * the beginning, or the records already on disk are permanently ambiguous. That is the
 * definition of a freeze blocker.
 *
 * THE RULE.
 *
 *   An unknown kind is NOT ignorable by default. It is ignorable only if the record that
 *   carries it says so. Criticality travels WITH the data, decided by the writer that
 *   understood it, not guessed by a reader that does not.
 */

import { S1_PROTOCOL_VERSION } from './s1-types.ts';

export class UnsupportedJournalError extends Error {}

/**
 * The record format this reader writes. Distinct from the identity scheme.
 *
 * ONE identifier, stamped in two places — `protocolVersion` on every event and
 * `formatVersion` on every record — so it is DERIVED here rather than typed a second time.
 * A duplicated literal is precisely the shape of the defect this revision exists to fix
 * (two hand-written copies of one fact, drifting), and the drift would be worse here than
 * it was there: a record whose envelope claims one revision while the events inside it
 * claim another is a record no reader can resolve, because both stamps are inside seals
 * and neither is more authoritative than the other.
 */
export const S1B_FORMAT_VERSION = S1_PROTOCOL_VERSION;

/**
 * Format identifiers this reader once wrote and can no longer verify, and why.
 *
 * WHY THIS EXISTS AT ALL — the failure it prevents is silent, not loud.
 *
 * `Storage.readJournal` discards every record its verifier rejects, and a trailing run of
 * rejects is by construction indistinguishable from an interrupted write. So a journal
 * written under a superseded SEAL RECIPE does not announce itself: every record fails the
 * new checksum, every record is discarded as torn, `corruptionInMiddle` never trips
 * because no valid record follows a bad one, and recovery returns an EMPTY kernel. The
 * next run then has no record of any claim, landing or settlement, and repeats all of
 * them. storage.ts already names this failure once (F-11, where the recipe was hard-coded
 * on the disk side); a version bump reaches the same place by a different road.
 *
 * So a retired identifier is not a historical note. It is the one thing that distinguishes
 * "these bytes are damaged" from "these bytes are fine and I am the wrong reader" — and
 * only the second of those is safe to answer by stopping.
 *
 * Entries are added, never removed: an identifier's meaning is fixed, and a reader that
 * forgets a retired format regains the silent-empty-recovery bug for it.
 */
export const RETIRED_FORMATS: ReadonlyMap<string, string> = new Map([
  ['2026-08-18',
    "its checksum and MAC covered only part of the envelope — `requiredFeatures` and "
    + '`mustUnderstand`, the reader\'s own interpretation instructions, were outside both '
    + '(S1b-1). `2026-08-19` seals the whole envelope under separated domains, so the two '
    + 'recipes disagree about every record and neither can verify the other'],
]);

/**
 * Refuse a record stamped with a format whose seals this reader does not implement.
 *
 * Deliberately NOT an allowlist. An identifier this reader has never heard of is a FUTURE
 * revision, and forward tolerance is decided where doc 29 §3 puts it — by feature bits and
 * by `mustUnderstand`, which are the fields that say what a reader would actually be
 * getting wrong. Refusing on the identifier alone would make every future revision
 * unreadable regardless of whether it changed anything this reader depends on, which is
 * the opposite of the negotiated compatibility PART 6 is built on.
 *
 * What this refuses is narrower and knowable: the identifiers we ourselves retired.
 */
export function assertFormatReadable(record: unknown): void {
  if (record === null || typeof record !== 'object') return;
  const version = (record as { formatVersion?: unknown }).formatVersion;
  if (typeof version !== 'string') return;
  const why = RETIRED_FORMATS.get(version);
  if (why === undefined) return;
  throw new UnsupportedJournalError(
    `refusing to read a record written under retired format '${version}': ${why}. `
    + 'A retired-format record is NOT corrupt and MUST NOT be discarded as an interrupted '
    + `write — read it with a reader that implements '${version}', or convert it as a `
    + 'deliberate, journaled act.',
  );
}

/**
 * Feature bits a journal may require of its reader.
 *
 * A reader that does not recognise a required feature fails closed. This is coarser than
 * per-kind negotiation and much harder to get wrong: a revision that changes what safety
 * means adds a feature bit, and every older reader stops rather than guessing.
 */
export const KNOWN_FEATURES: ReadonlySet<string> = new Set([
  'effect-identity/1',
  'writer-fencing/1',
  'journal-mac/1',
  'must-understand/1',
]);

/**
 * Which event kinds carry semantics a reader MUST understand to be safe.
 *
 * The test is not "is this kind important?" but "if a reader silently skipped this, could
 * it reach a WRONG and DANGEROUS conclusion?" — could it under-protect an effect,
 * over-grant authority, under-count a budget, or resurrect a settled invocation.
 *
 * `state.updated`, `evidence.produced` and the advisory kinds are deliberately absent:
 * skipping them loses information, which is bad, but it cannot make a reader believe an
 * irreversible effect never happened.
 */
export const MUST_UNDERSTAND_KINDS: ReadonlySet<string> = new Set([
  'effect.claimed', 'effect.landed', 'effect.released', 'effect.settled',
  'invocation.admitted', 'invocation.completed', 'invocation.failed',
  'invocation.uncertain', 'invocation.uncertainty.resolved',
  'grant.issued', 'grant.attenuated', 'grant.reserved', 'grant.settled', 'grant.revoked',
  'execution.created', 'execution.forked',
  'writer.fenced',
]);

/** Every kind this reader implements. Anything else is unknown BY THIS READER. */
export const KNOWN_KINDS: ReadonlySet<string> = new Set([
  ...MUST_UNDERSTAND_KINDS,
  'invocation.dispatched', 'invocation.canceled', 'invocation.suspended',
  'invocation.resumed', 'invocation.cancel.requested',
  'effect.claim.denied', 'effect.deduplicated',
  'artifact.produced', 'state.updated', 'evidence.produced',
  'grant.released', 'grant.denied', 'delivery.duplicate',
  'checkpoint.cut', 'policy.denied', 'identity.resolved', 'escape.invoked',
]);

/** The compatibility envelope every S1b commit record carries. */
export interface CompatEnvelope {
  readonly formatVersion: string;
  /** Features a reader must implement to interpret this record safely. */
  readonly requiredFeatures: readonly string[];
  /** Per-event: is this kind safety-critical? Written by the writer that understood it. */
  readonly mustUnderstand: readonly string[];
}

export function envelopeFor(kinds: readonly string[]): CompatEnvelope {
  return {
    formatVersion: S1B_FORMAT_VERSION,
    requiredFeatures: [...KNOWN_FEATURES].sort(),
    mustUnderstand: [...new Set(kinds.filter((k) => MUST_UNDERSTAND_KINDS.has(k)))].sort(),
  };
}

export interface ReaderVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * May this reader interpret this record?
 *
 * Four outcomes, each decided rather than defaulted:
 *
 *   unknown OPTIONAL kind      skip it, advance the cursor. Forward compatibility, kept.
 *   unknown REQUIRED kind      FAIL CLOSED. This is the case S1 got wrong.
 *   unknown required FEATURE   FAIL CLOSED, even if every kind happens to be familiar —
 *                              a feature bit can change what a FAMILIAR kind means.
 *   known kind, newer schema   upcast if an upcaster exists; fail closed if not. A reader
 *                              must never apply a payload whose shape it is guessing at.
 */
export function canInterpret(
  record: { formatVersion?: string; requiredFeatures?: readonly string[]; mustUnderstand?: readonly string[] },
  events: readonly { kind: string; schemaVersion: number }[],
  upcasters: UpcasterRegistry,
): ReaderVerdict {
  // A record with no compatibility envelope is a pre-S1b record. It is not ignorable and
  // it is not readable by this path: the caller decides whether to run it through a format
  // upcaster, which is an explicit act.
  if (record.formatVersion === undefined) {
    return { ok: false, reason: 'record carries no formatVersion; it predates must-understand semantics' };
  }

  for (const feature of record.requiredFeatures ?? []) {
    if (!KNOWN_FEATURES.has(feature)) {
      return { ok: false, reason: `journal requires feature '${feature}' that this reader does not implement` };
    }
  }

  const required = new Set(record.mustUnderstand ?? []);
  for (const ev of events) {
    if (!KNOWN_KINDS.has(ev.kind)) {
      if (required.has(ev.kind)) {
        return {
          ok: false,
          reason: `event kind '${ev.kind}' is marked must-understand and this reader does not implement it`,
        };
      }
      continue;                                   // unknown OPTIONAL: safe to skip
    }
    const known = upcasters.currentSchema(ev.kind);
    if (ev.schemaVersion > known && !upcasters.has(ev.kind, ev.schemaVersion)) {
      return {
        ok: false,
        reason: `event '${ev.kind}' is schema v${String(ev.schemaVersion)}; this reader implements v${String(known)} and has no upcaster`,
      };
    }
  }
  return { ok: true };
}

/**
 * Upcasting: old records stay immutable, the reader converts on the way in.
 *
 * Chosen over the alternatives for one reason. The journal is the authoritative history of
 * what happened to the world; rewriting it to fit a new shape means editing the record of
 * a charge that really occurred, and an offline migration that crashes halfway leaves a
 * journal that is half one format and half another with no way to tell which. Version-
 * specific folds were the other candidate and were rejected as a *maintenance* trap: N
 * folds means N places for the protection rule to drift, which is B4 reintroduced by the
 * back door. One fold, many upcasters, immutable history.
 */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

export class UpcasterRegistry {
  private readonly byKind = new Map<string, Map<number, Upcaster>>();
  private readonly current = new Map<string, number>();

  /** Declare the schema version this reader natively implements for a kind. */
  declare(kind: string, schemaVersion: number): void {
    this.current.set(kind, schemaVersion);
  }

  /** Register a conversion from `fromVersion` into the native version. */
  register(kind: string, fromVersion: number, fn: Upcaster): void {
    const m = this.byKind.get(kind) ?? new Map<number, Upcaster>();
    m.set(fromVersion, fn);
    this.byKind.set(kind, m);
  }

  currentSchema(kind: string): number { return this.current.get(kind) ?? 1; }
  has(kind: string, version: number): boolean { return this.byKind.get(kind)?.has(version) === true; }

  /** Convert a payload into native shape, or refuse. Never guesses. */
  upcast(kind: string, schemaVersion: number, payload: Record<string, unknown>): Record<string, unknown> {
    const native = this.currentSchema(kind);
    if (schemaVersion === native) return payload;
    const fn = this.byKind.get(kind)?.get(schemaVersion);
    if (fn === undefined) {
      throw new UnsupportedJournalError(
        `no upcaster for '${kind}' v${String(schemaVersion)} → v${String(native)}`,
      );
    }
    return fn(payload);
  }
}

/** The registry this reader ships with. Every known kind is declared at v1. */
export function defaultUpcasters(): UpcasterRegistry {
  const r = new UpcasterRegistry();
  for (const kind of KNOWN_KINDS) r.declare(kind, 1);
  return r;
}
