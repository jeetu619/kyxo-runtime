# 31 — Wave S1b Freeze Decision

Date: 2026-08-16. Format candidate `2026-08-18`. Review tag `s1b-review-candidate`.
Evidence: `docs/30`. Suite at decision time: 224 pass, 0 fail.

# RECORD FORMAT NOT READY TO FREEZE

---

## 1. The decision in one paragraph

S1b fixed real things. Semantic effect identity is a genuine advance over `sha(request)`,
and the six ordinary developer behaviours that double-charged under S1 now charge once.
But five independent reviewers, given a tagged commit and a green 224-test suite, produced
**twelve FATALs with working reproductions**, three of them format-level and therefore
un-retrofittable, and **four of them are the same defect S1 was supposed to have taught us**:
a mechanism that exists, is correct, is tested, and is *never called on the runtime path*.

---

## 2. The governing rule, and how badly it held

The phase brief set one rule: **"implemented" is not "in force."** A mechanism counts only
if it is structurally on the runtime path and cannot be bypassed.

S1's single largest finding was that `assertS1Invariants` had zero call sites in `src/`.
S1b was written knowing that. The reviewers found:

| Mechanism | Call sites in `src/` | Consequence |
|---|---|---|
| `assertS1Invariants` | **0** | unchanged from S1 |
| `schemeSupported()` | **0** (imported, never called) | identity scheme id is decorative |
| `verifyRecordedIdentity()` | **0** | persisted identity is **write-only** |
| `UpcasterRegistry.upcast()` | **0** | the migration mechanism is inert; the registry is a gate that opens and converts nothing |

The fold never reads `payload['identity']`. `invoke()` re-derives every effect key from the
live `IDENTITY_SCHEME` constant on every call — so doc 27 I-2's central protection ("a
reader MUST NOT re-derive an identity it can read") is **true only because nothing reads
it**. A reviewer changed the scheme to `/2`, updated the two literal assertions a migrator
would update anyway, and got **222/222 green and two charges on a real journal**.

This is the pattern, four times over, in a wave written specifically to avoid it.

---

## 3. Freeze criteria

| Criterion | Status |
|---|---|
| Effect identity — ordinary variation cannot duplicate | **PARTIAL** — schema path holds; caller-key path, `namespace`, delegation and array order do not |
| Lost-ack safety | **FAILED** — `probe` cannot answer its own question; auto-retry reachable |
| Writer fencing | **FAILED** — fences the wrong family; `recover()` writes unfenced |
| Journal authenticity | **FAILED** — tail truncation undetected; `mustUnderstand` unsigned; `keyId` unbound to `writerId` |
| Reader compatibility | **FAILED** — the gate covers one call site; `fork()` reads unauthenticated disk |
| Schema evolution | **FAILED** — no immutable corpus; upcasting inert |
| Cross-version identity | **FAILED** — a migration re-identifies effects; nothing checks the scheme |
| Lifecycle authorization | **FAILED** — four entry points require only an execution-id string |
| Single fold | **FAILED** — `recover()` and `fork()` disagree about the same journal |
| Crash recovery | **PARTIAL** — new mechanisms uncovered by the matrix |
| Property testing | **PARTIAL** — the model never reaches the paths that broke |
| Security tests | **FAILED** — 12 FATALs |
| Storage conformance | **FAILED** — no contract written; `canonical`/`JSON.stringify` disagree on array holes |
| Independent review | **FAILED** — unresolved FATALs |

**1 of 14 criteria is even partially satisfied in the way the brief requires.**

---

## 4. Remaining blockers, in the required form

### Blocker 1 — the MAC does not cover the interpretation instructions
- **Reproduction:** `scratchpad/s1b-sec/02-must-understand-strip.ts`, `s1b-schema/attack1-*.ts`
- **Root cause:** `macPreimage` covers `{commitToken, executionId, familyId, writerId, epoch, formatVersion, events}`. `mustUnderstand` and `requiredFeatures` are outside it and outside the checksum.
- **Records affected:** every record.
- **Semantic decision:** the MAC must commit to the whole envelope minus the MAC, with domain separation.
- **Smallest next experiment:** move both fields into the preimage and the checksum; re-run the strip attack.

### Blocker 2 — the journal has no anchor
- **Reproduction:** `scratchpad/s1b-sec/01-truncation-double-charge.ts`
- **Root cause:** records are authenticated individually; nothing commits to the *set*. Head truncation is caught by seq density; tail truncation is undetectable by construction.
- **Semantic decision:** per-family committed tip, or a predecessor-MAC chain.
- **Smallest next experiment:** add a tip record; delete the tail; assert refusal.

### Blocker 3 — `keyId` is not bound to `writerId`
- **Reproduction:** `scratchpad/s1b-sec/03-key-confusion.ts`
- **Root cause:** the keyring is the union of all keys that must stay verifiable, so any key verifies any claimed `writerId`.
- **Semantic decision:** a verifier needs `writerId → allowed keyIds`, or per-writer key namespacing.

### Blocker 4 — persisted identity is write-only
- **Reproduction:** `scratchpad/s1b-schema/attack4-migration-reidentifies-effects.ts`
- **Root cause:** `schemeSupported()` and `verifyRecordedIdentity()` are never called; the fold never reads `payload['identity']`; `invoke()` re-derives from a live constant.
- **Semantic decision:** recovery must read the recorded scheme and fail closed on a scheme it does not implement; the fold must use the recorded key.

### Blocker 5 — fencing is checked against the wrong family, and `recover()` writes unfenced
- **Reproduction:** `scratchpad/s1b-fence/01-cross-family-lease.ts`, `03-recover-is-unfenced.ts`
- **Root cause:** one `lease` field per kernel, overwritten per family; `recover()` is a static with no fencing parameter that nonetheless commits triage records.
- **Semantic decision:** lease per family, and recovery must acquire before it appends.

### Blocker 6 — the fence trips after the world is touched
- **Reproduction:** `scratchpad/s1b-fence/04-fence-destroys-world-truth.ts`
- **Root cause:** `assertOwns` throws before `appendCommit`, so the `effect.landed` record is discarded — the kernel's own doctrine says a report that the world changed is never discarded.
- **Semantic decision:** a landing must be recorded even by a writer that has just lost its lease, or the effect must not be dispatchable without a re-checked lease.

### Blocker 7 — no immutable golden corpus
- **Root cause:** the only "golden" test regenerates its input from the current writer; it caught 0 of 2 coordinated mutations that double-charge real journals.
- **Smallest next experiment:** commit `.jsonl` bytes from `2026-08-18` and assert a pinned fold digest.

### Blocker 8 — lifecycle authorization
- **Root cause:** `issueGrant`, `fork`, `cancel`, `resolveUncertainty` take no handle. `resolveUncertainty({kind:'compensate'})` issues a real refund.
- **Semantic decision:** an issuer-authority model — who may mint a grant, and against what. This is a design decision, not a patch.

---

## 5. What was fixed, and what that says

F-38 (must-understand exists at all), F-39 (fencing configured before the first append),
F-40 (the idempotency option was the double-charge) and F-41 (`effectClassOverride` was an
unguarded off-switch) are fixed and pinned by regression tests. F-40 and F-41 were each
found **independently by two reviewers**, which is the strongest available signal that a
finding is structural.

Both were mine, and both shipped green.

---

## 6. Strategic build decision

**BUILD WITH CHANGES** — unchanged, and this wave supports it rather than undermining it.

Record-format freeze and the build decision are separate questions. Nothing found here says
the architecture is wrong; the nine kernel objects, the capability contract, the pure-proposer
barrier, family-scoped ledgers and the fail-closed identity instinct all held under five
hostile reviews. What failed is the *integration* of new mechanisms onto the runtime path —
which is a discipline problem with a known and now well-evidenced fix.

---

## 7. Next engineering step

**One phase only: close Blockers 1–7 as a single coherent record-format revision
(`2026-08-19`), then re-review against a fresh tag.**

Do not start S2. Do not build production packages. Blocker 8 (issuer authority) is a design
question that should be answered in writing before it is coded.

And one process change, earned four times over: **a mechanism does not count as implemented
until a test asserts it is called on the runtime path.** Every one of this wave's
zero-call-site defects would have been caught by a single test that greps `src/` for the
call site — the same shape as the universality gate, which is the one guard that has
survived three reviews.
