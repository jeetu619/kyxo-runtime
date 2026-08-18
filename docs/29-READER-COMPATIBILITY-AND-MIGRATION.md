# 29 — Reader Compatibility and Migration (normative)

Status: **NORMATIVE DRAFT**, 2026-08-16, Wave S1b. Format `2026-08-19` (§3.2).
Executable form: `prototypes/kernel-semantics/src/s1b-compat.ts`. Evidence: `docs/30`.

---

## 1. The rule S1 got backwards

S1 offered this as **evidence of safety**:

> "unknown kinds advance the cursor without changing semantics"

It is a double-charge path, and doc 25 §6's judgement that schema evolution was "additive …
not a freeze blocker on their own" is the one conclusion the independent review overturned
outright. The reproduction:

> A revision `2027-01-01` renames `effect.landed` to `world.landed` and re-signs. Every
> record verifies, the chain is intact. Today's fold meets `world.landed`, finds no case for
> it, and treats it as a no-op. The landing vanishes. `hasLanded` is false. Protection never
> engages. **The card is charged a second time, with every invariant green.**

Forward tolerance and safety are in direct conflict, and S1 resolved it in favour of
tolerance by default. That is backwards for anything protecting money.

**Why it cannot wait:** a must-understand bit added in revision R+1 tells a reader *nothing*
about a record written under revision R. The bit has to be in the record from the beginning
or the records already on disk are permanently ambiguous.

---

## 2. The rule

> An unknown kind is **not ignorable by default**. It is ignorable only if the record that
> carries it says so. Criticality travels **with the data**, decided by the writer that
> understood it — never guessed by a reader that does not.

---

## 3. Reader behaviour, exhaustively

| Case | Behaviour |
|---|---|
| unknown **optional** kind | skip, advance the cursor. Forward compatibility, preserved where it is safe. |
| unknown **required** kind | **FAIL CLOSED.** The case S1 got wrong. |
| unknown **feature bit** | **FAIL CLOSED**, even if every kind is familiar — a feature bit can change what a familiar kind *means*. |
| known kind, newer schema | upcast if an upcaster is registered; **fail closed** if not. A reader must never apply a payload whose shape it is guessing at. |
| record with **no compatibility envelope** | refused. Pre-S1b records predate must-understand; reading them is an explicit act, not a default. |
| record naming a **retired** format identifier | refused **by name**, with the reason. Not "corrupt" — the bytes are fine and this is the wrong reader (§3.2). |
| record naming an **unrecognised** format identifier | *not* refused on the identifier alone. It is a future revision, and feature bits and `mustUnderstand` are what say whether this reader would get it wrong. |
| new reader, old journal | readable when the reader implements the older kinds and schemas; otherwise refused. |

### 3.1 Which kinds are must-understand

The test is not "is this kind important?" but **"could silently skipping it produce a wrong
and dangerous conclusion?"** — could it under-protect an effect, over-grant authority,
under-count a budget, or resurrect a settled invocation.

Must-understand: `effect.claimed`, `effect.landed`, `effect.released`, `effect.settled`,
`invocation.admitted`, `invocation.completed`, `invocation.failed`, `invocation.uncertain`,
`invocation.uncertainty.resolved`, `grant.*` (issue/attenuate/reserve/settle/revoke),
`execution.created`, `execution.forked`, `writer.fenced`.

Deliberately optional: `state.updated`, `evidence.produced`, `artifact.produced` and the
advisory kinds. Skipping them loses information, which is bad, but it cannot make a reader
believe an irreversible effect never happened.

### 3.2 The identifier moves when the seal recipe moves — `2026-08-18` → `2026-08-19`

S1b-1 moved `requiredFeatures` and `mustUnderstand` inside both seals and separated the
checksum and MAC domains (doc 28 A-2, A-5). No field changed name or type, so the change
*looks* additive. It is not:

> A seal recipe is not metadata about a record. It is the rule by which a reader decides the
> record is genuine. A `2026-08-18` record and a `2026-08-19` record with byte-identical
> fields carry different, non-interchangeable checksums, and neither reader can verify the
> other's records.

Two non-interoperable recipes under one identifier is the definition of an ambiguous format:
a reader holding a record stamped `2026-08-18` could not tell which rule made it, and would
have to guess or accept both — and accepting both re-opens the gap the revision closed. So
the identifier moves and `2026-08-18`'s meaning stays fixed, exactly as `2026-08-17`'s did.
There is no legacy verification path, and there is nothing to migrate: `2026-08-18` was a
freeze *candidate* that doc 31 refused to freeze, so no journal under it is authoritative.

**The refusal MUST be explicit, and this is the load-bearing half.** A reader discards what
it cannot verify, and a trailing run of discards is indistinguishable from an interrupted
write. So a journal under a superseded recipe does not announce itself: every record fails
the new checksum, every record is discarded as torn, nothing is flagged as corruption because
no valid record follows a bad one, and recovery returns an **empty kernel** — after which the
next run repeats every claim, landing and settlement in it. A retired identifier is what
distinguishes *"these bytes are damaged"* from *"these bytes are fine and I am the wrong
reader"*, and only the second is safe to answer by stopping. (The same failure reached by a
different road is recorded in `storage.ts` as F-11.)

Two consequences bind future revisions:

- Retired identifiers are **added, never removed**. A reader that forgets one regains the
  silent-empty-recovery bug for it.
- The check is a **retired-list, not an allowlist**. Refusing every identifier this reader has
  not seen would make PART 6 pointless — feature bits and `mustUnderstand` exist so a reader
  can decide whether a future revision changed anything it depends on, rather than stopping
  at a date it does not recognise.

Evidence: `tests/s1b-authority.test.ts` V1–V4.

---

## 4. Migration philosophy: upcasting

Old records stay **immutable**; the reader converts on the way in.

| Candidate | Verdict |
|---|---|
| **Upcasting** | **CHOSEN.** History is the authoritative record of what happened to the world. |
| Offline rewrite | **Rejected.** It means editing the record of a charge that really occurred, and a migration that crashes halfway leaves a journal half one format and half another with no way to tell which. |
| Version-specific folds | **Rejected** as a maintenance trap: N folds means N places for the protection rule to drift, which is B4 reintroduced by the back door. |

**One fold, many upcasters, immutable history.**

### 4.1 What a format upgrade MUST NOT do

Repeat an external effect · lose effect protection · reset budget usage · broaden a grant ·
lose lineage · turn `uncertain` into `completed` · **change semantic effect identity** ·
reinterpret an old irreversible effect as new.

---

## 5. Cross-version effect identity (PART 8)

The identity scheme (`kyxo.effect-identity/1`) is versioned **independently of the record
format**, and resolved identity is **persisted** in `invocation.admitted`.

A reader MUST NOT re-derive an identity it can read. If it did, changing the derivation in
V2 would silently re-identify every effect written under V1 — making every historical
irreversible effect repeatable, all at once, on upgrade. This is the single most dangerous
migration failure available to this design, and persistence is what forecloses it.

A reader meeting an identity scheme it does not implement MUST fail closed.

---

## 6. Golden histories

Future readers MUST be run against **immutable, checked-in journal bytes** from named
revisions. A corpus that regenerates its input from the current writer cannot detect a
change that alters both what the writer writes and how the reader reads — which is exactly
what a format revision does. S1's golden test did regenerate its input and caught 1 of 10
semantic mutations.

**Status: NOT YET SATISFIED.** See doc 31 §Remaining blockers.
