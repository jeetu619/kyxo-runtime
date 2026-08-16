# 26 — Wave S1b: Record-Format Freeze Hardening

Date: 2026-08-16. Branch `claude/wave-s1-record-format`. Review tag `s1b-review-candidate`.
Format candidate **`2026-08-18`**. Baseline at entry: 181 tests green, typecheck clean,
fuzz clean, phase-1 gates pass.

**Governing rule for this wave, taken from S1's failures: "implemented" is not "in force."**
A mechanism counts only if it is structurally on the runtime path, cannot be bypassed
accidentally, is exercised by hostile tests, survives crash and recovery, and cannot be
reached around by another path. Unused validators, test-only enforcement, comments,
manifests, conventions and cooperative provider behaviour count as none of those things.

---

## 1. The authoritative blocker matrix (PART 1)

Reconstructed from `docs/25` §11.3–11.4 (the current authoritative status), not from the
phase brief. The repository named **one more open item than the brief did** — mutable
`family()` / `rehydrateGrant` escalation — and one the brief folded into "residue":
`expiresAt` denominated in journal entries.

| Blocker | Status at S1b entry | Why not frozen | Semantic decision required | Executable evidence required |
|---|---|---|---|---|
| **Effect identity** (B1 residue, F-3/F-4/F-5 of the SDK review) | PARTIAL | `sha(whole request)` made a nonce, timestamp, trace id or retry a new effect | what identifies "the same real-world operation"; what happens when nobody says | ordinary-developer matrix counting real charges |
| **Writer identity / fencing** (new) | ABSENT | two writers produced byte-identical records; the violation was unattributable and unfixable after a freeze | writer id, epoch, acquisition, staleness, storage requirement | stale writer with a valid key must be refused |
| **Journal authenticity** (B6 residue) | PARTIAL | unkeyed chain: an attacker with disk access re-chains everything and every check passes | threat model; MAC vs signature; key lifecycle | re-sealed forgery detected; replay across execution/fork/epoch detected |
| **Must-understand reader** (B7) | UNCHANGED, reclassified freeze-blocking | "unknown kind → no-op" is a live double-charge path | criticality travels with the record | old reader meeting a required unknown kind fails closed |
| **Schema evolution** (B7) | UNCHANGED | no per-kind versioning, no upcaster, no immutable corpus | upcasting vs rewrite vs version-specific folds | golden histories that are NOT regenerated |
| **Cross-version identity** (PART 8) | ABSENT | a changed derivation would re-identify all history at once | persist identity; version the scheme separately | identity read from the record, never recomputed |
| **Lifecycle authority** (B5 residue) | PARTIAL | `resume()` bypassed all authority | every entry point enforces the same model | the audit table in §3 |
| **B4 fold ordering** | PARTIAL | the fold is deterministic over an ordering the format does not define | family-level ordering | — |
| **B9 time** | UNCHANGED, active defect | `expiresAt` is enforced in units of journal entries | what a deadline means | — |

Findings F-21…F-39 map to these clusters as follows: F-21 (universality gate) → lifecycle
authority; F-22/F-25/F-26 → effect identity; F-23/F-28 → budgets; F-27/F-30/F-33/F-35/F-37 →
claim and lease lifecycle; F-29 → lifecycle authority; F-31/F-32 → journal authenticity;
F-36 → boundary snapshot; F-38 → must-understand; F-39 → writer fencing.

---

## 2. What S1b changed

| Area | Mechanism | File |
|---|---|---|
| Effect identity | caller `idempotencyKey` **or** capability-declared allowlist; **fail closed** for irreversible classes with neither; identity persisted with its scheme | `src/s1b-identity.ts` |
| Writer authority | `writerId` + `epoch` on every record; compare-and-set acquisition; fence checked **per append**; configured before the first append | `src/s1b-writer.ts` |
| Authenticity | per-record HMAC over a preimage binding family, writer, epoch and format; constant-time verify; rotation without migration | `src/s1b-writer.ts` |
| Reader compatibility | `formatVersion` + `requiredFeatures` + per-record `mustUnderstand`; unknown-required and unknown-feature fail closed; upcaster registry | `src/s1b-compat.ts` |
| Format identifier | `2026-08-17` → **`2026-08-18`**; the old identifier's meaning is fixed, not mutated | `src/s1-types.ts` |

The migration of the existing fixtures is itself the evidence that the identity rule is on
the runtime path rather than in a validator nobody calls: **86 of 181 tests failed the
moment it landed**, every one with *"declares effect class external-irreversible but no
effect identity."*

### 2.1 Three semantic decisions the migration forced

Recorded because each was decided, not defaulted:

1. **An absent identity field is a stable sentinel**, not an error and not an omission.
   Requiring every field makes optional semantic fields impossible ("charge with no
   currency" is a legitimate, *different* operation); omitting them would make `{a:1}` and
   `{a:1,b:2}` collide.
2. **`step` participates in identity only on the fallback path.** Whoever declares identity
   owns it; letting an incidental step split a declared identity reintroduces the S1 defect.
3. **Two capabilities declaring the same operation ARE the same operation.** Identity
   anchors on the operation name, not the capability id — which is what lets a wrapper, a
   retry shim or a v2 rollout preserve identity instead of re-charging everything.

---

## 3. Lifecycle authority audit (PART 10)

Read from `src/s1-kernel.ts` rather than from intent. **This table is the most important
negative result in S1b.**

| Entry point | Identity | Grant | Policy | Budget | Writer fence |
|---|---|---|---|---|---|
| `invoke` | ✅ resolved + persisted | ✅ handle required | ✅ | ✅ | ✅ |
| `resume` | ✅ from record | ✅ chain checked | ✅ | ✅ (lease retained) | ✅ |
| `attenuate` | n/a | ✅ handle required | — | ✅ cannot widen | ✅ |
| `revoke` | n/a | ✅ handle required | — | n/a | ✅ |
| **`issueGrant`** | n/a | ❌ **no handle** | ❌ | ❌ | ✅ |
| **`fork`** | n/a | ❌ **no handle** | ❌ | ❌ | ✅ |
| **`cancel`** | n/a | ❌ **no handle** | ❌ | ❌ | ✅ |
| **`resolveUncertainty`** | ✅ from record | ❌ **no handle** | ❌ | ❌ | ✅ |
| `recover` | ✅ | n/a | — | — | ❌ **no lease taken** |

**Four entry points require nothing but an execution-id string** — a value returned in every
outcome and printed in every log. Anyone holding one can mint unlimited authority
(`issueGrant`), branch a lineage (`fork`), cancel work (`cancel`), or resolve an uncertainty
— and `resolveUncertainty({kind:'compensate'})` issues a **real refund**, while
`adopt-landed` permanently poisons an effect key.

This is exactly the condition the phase brief names: *"No lifecycle path should exist solely
because it was added later and bypass the normal enforcement path."* It is **not fixed in
S1b**, and it blocks the freeze. Fixing it requires an issuer-authority model — deciding who
may mint a grant, and against what — which is a design decision, not a patch, and inventing
one under time pressure is how the S1 defects were created.
