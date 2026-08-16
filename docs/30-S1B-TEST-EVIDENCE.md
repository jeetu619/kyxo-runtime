# 30 — Wave S1b Test Evidence

**This document leads with failures, because the failures are the result.**

224 tests pass. That number is not the evidence and should not be read as it. Four
independent reviewers, given a tagged commit with a green suite, produced **~40 findings
including 12 FATALs with working reproductions**, every one of them in a path the 224 tests
reach. The suite was green throughout.

---

## 1. Falsifications (F-38 … F-41)

| # | What failed | Found by | Fixed? |
|---|---|---|---|
| **F-38** | "unknown kind advances the cursor" offered as evidence of safety — a live double-charge path | S1 review | ✅ must-understand |
| **F-39** | Configuring fencing after the first append leaves an unsigned prefix, indistinguishable from a stripped MAC | self, while writing the authority suite | ✅ fencing configured at construction |
| **F-40** | **The idempotency option was the double-charge.** A caller `idempotencyKey` outranked a capability's declared schema, so `idempotencyKey: randomUUID()` — the habit every payments tutorial teaches — produced 3 charges. The option *named for the problem* reintroduced it. | **2 reviewers independently** | ✅ a declaration now requires `overrideCapabilityIdentity` to override |
| **F-42** | **The fold pushed a landing unconditionally on uncertainty resolution**, while the branch six lines above guarded with `hasLanded`. One real charge became two landed records, durably, surviving restart — and invisible to S1-I3 because live and replayed state were equally wrong. Crash-matrix 16/18 walks this exact path and stops one line before a `restart()` would have caught it. | reviewer 6 | ✅ guarded |
| **F-41** | **`effectClassOverride` was an unguarded off-switch.** One type-correct option removed protection, the fail-closed identity rule and the exclusive claim together, with none of the ceremony the *actual* escape hatch carries. The landing was then recorded as repeatable, so the journal durably asserted an irreversible charge may be repeated. | **2 reviewers independently** | ✅ rights-gated and journaled as a downgrade |

Independent convergence on F-40 and F-41 is the strongest signal available that a finding is
structural rather than stylistic. Both were mine, both shipped green.

---

## 2. FATAL findings NOT fixed

Listed first because they decide the freeze. Each has a reproduction in the reviewers'
scratch directories.

### 2.1 Format-level — cannot be retrofitted after a freeze

| # | Finding | Consequence |
|---|---|---|
| **S1b-1** | **`mustUnderstand` and `requiredFeatures` are outside the MAC preimage.** | Storage with **no key** sets `mustUnderstand: []`, recomputes the unkeyed checksum, leaves the MAC untouched → the fail-closed layer is voided → landing vanishes → **card charged twice**. F-38 reopened through the MAC gap. |
| **S1b-2** | **No journal anchor.** Records are authenticated; the journal is not. There is no committed tip, record count or per-family high-water mark. | **Tail truncation is undetected** even with a signer. Delete the last N lines: recovery returns cleanly, `landed: 0`, retry admitted, **card charged twice**. Head truncation *is* caught by seq density — the asymmetry is purely the missing anchor. |
| **S1b-3** | **`keyId` is not bound to `writerId`.** | The keyring is by design the union of all keys that must stay verifiable, so writer-B signs records claiming `writerId: 'writer-A'` and authenticated recovery accepts them. `writerId` is present and bound to nothing a verifier can check — which refutes this wave's own stated purpose of making the violation *attributable*. |

### 2.2 Code-level — fixable, but each is a live double-execution today

| # | Finding | Consequence |
|---|---|---|
| **S1b-4** | **`assertOwns` fences against the lease's family, not the family being written.** A kernel holds one `lease` field; `ensureLease` overwrites it per family. | A writer that has touched two families is **not fenced** on the first. Superseded writer appends authoritative records and **charges twice**. W2 passes only because its kernel has one family. |
| **S1b-5** | **`recover()` takes no lease and writes anyway.** Its own triage commits `invocation.uncertain` unsigned (`mac:''`, `epoch:0`, `writerId:'unfenced'`). | One authenticated crash-recovery **permanently destroys that journal's authenticity** — every later `recover({signer})` throws. Recovery is not idempotent under authenticity, and it is structurally incapable of complying with this wave's own W-4. |
| **S1b-6** | **`recover()` without a `signer` verifies nothing.** Records declare `requiredFeatures: ['journal-mac/1']`; `canInterpret` checks the reader *recognises* the bit, never that it *enforced* it. | A keyless attacker excises the charge from the middle, renumbers `seq`, re-chains → accepted silently → **charged twice**. Doc 28's "there is no silent downgrade" is false: omitting one optional argument is one. |
| **S1b-7** | **The fence trips *after* the world is touched.** `assertOwns` throws before `appendCommit`, so the `effect.landed` commit writes nothing. | A mid-flight takeover **discards the record of a charge that really happened**; triage then records `landed:false`, the F-13 guard cannot fire, and the retry charges again. Contradicts the kernel's own doctrine: *"A report that the world changed is never discarded."* Same shape for `compensate`: **two refunds for one charge**. |
| **S1b-8** | **`probe` cannot answer its own question.** `probe(effectKey)` receives the kernel's digest, but `InvokeCtx` never contains the effect key. | A provider has no way to have recorded anything under that key, so the natural implementation returns `not-landed` for an effect that landed → claim released → **charged twice**, with no operator, no right, no policy stage. `external-idempotent` is likewise asked to be idempotent "under the effect key" it is never given. |
| **S1b-9** | **`assertS1Invariants` still has zero call sites in `src/`.** | **S1's single biggest finding, recurring.** The duplicate exclusive landing S1b-3 injects violates S1-I4 and is invisible on the runtime path. |
| **S1b-10** | **Four lifecycle entry points require nothing but an execution-id string** — `issueGrant`, `fork`, `cancel`, `resolveUncertainty` (self-audited, doc 26 §3). | Anyone with an id from a log can mint unlimited authority, or issue a **real refund** via `resolveUncertainty({kind:'compensate'})`. |

### 2.3 Cross-family and doc defects

- **`createExecution()` twice double-charges**, and **doc 27 §5's stated mitigation is false**: an `idempotencyKey` changes the effect *key*, but the claim table and `protectionFor` are fields of `FamilyProjection`, so the lookup never crosses the family. Two reviewers verified byte-identical keys and two charges. The limitation is defensible; **stating a mitigation that does not mitigate is not.** The only working recipe is `fork()` from the original `ExecutionId`, which appears in no example.
- **`canonical()` and `JSON.stringify()` disagree on array holes** — a caller request with a hole produces a record that fails **its own** checksum on read-back, after the money moved. Any caller can brick the journal; no key required.
- **`namespace` is "forgotten `step`" renamed** — an optional caller string that participates in identity and silently defaults, which I-8 explicitly forbids for `step`.
- **Delegation drops `namespace` and `idempotencyKey`**, so tenant separation evaporates one hop down.
- **Identity anchors on `capabilityId` on the caller-key path**, making I-9 false exactly where the spec calls that path "highest precedence".

---

## 3. What held

Worth stating, because it is real and it is what a next wave builds on.

The **schema path** is genuinely good. ID1–ID12's variation — nonce, timestamp, trace id, key
order, telemetry, forgotten `step`, restart, sibling fork, nested fork, crash-then-retry —
survived every reviewer's attempt to widen it, and the over-dedup direction is tested too.
Lineage-tree protection is correctly family-wide and correctly ignores the newcomer's
declared class. `canonical()`'s refusal of `Date`/`Map`/class instances is right, and it is
injective where it matters. `timingSafeEqual` is used correctly. Re-attribution across
execution, family, writer, epoch and commit token is genuinely rejected. No key reaches
userland. A delegated irreversible child does inherit the fail-closed rule.

**The allowlist-not-blocklist instinct is correct.** The defects are not in that idea; they
are in every path that reaches the identity function *around* it.

---

## 4. Why the suite was green

Worth recording, because it is the transferable lesson. Each authenticity test probed its
mechanism in the direction that passes:

- A2/A3 call `signer.verify()` directly rather than driving `recover()`;
- C6 *adds* a feature bit rather than removing one;
- W4 exercises `registry.acquire()` rather than the `acquireWriter()` path a kernel takes;
- W2 uses a single family, which is the only case where the fence is checked correctly;
- **no test calls `recover()` without a signer on a tampered journal.**

A test that exercises a mechanism only where it works is a test that measures intent.

---

## 5. Workloads run

| Workload | Result |
|---|---|
| full suite | 224 pass / 0 fail, ~19s |
| typecheck | clean |
| property + differential, 60 seeds × 50 steps | 62 pass |
| seeded fuzz, 10 × 60 ops | clean |
| phase-1 gates (`kernel/validate.sh`) | all pass |
| independent adversarial review, **6 of 6 reporting** | **~50 findings, 13 FATAL** |


---

## 6. Findings from the sixth reviewer (event sourcing)

Confirms F1 (must-understand outside both envelopes) independently — **three reviewers
reached it separately**, which is the strongest convergence in either wave. Adds:

- **S1b-11 — quarantine repeals family-scoped protection silently.** Quarantine stops
  folding one *execution*; claims, landings and grants are *family*-scoped. Dropping the
  record carrying `invocation.admitted + effect.claimed` yields `landed: 0, claims: 0`, the
  fork stays usable, and the retry charges again — while the operator report says only
  `"seq 7 follows 2"`. **Now fixed**: the invariants run under quarantine and the violation
  is reported as *"protection, authority or budget may have been repealed."*
- **S1b-12 — no family-level ordering key.** Re-interleaving two executions' records — every
  per-execution `seq` dense, every chain link intact — changes the `landed` log order and
  fails S1-I3 on a *correct* journal. Any partitioned log or sharded table does this.
  Format-level.
- **S1b-13 — `foldEvent` is neither total nor idempotent.** Seven malformed-input crash
  classes escape `recover()` even under quarantine; folding the same records twice doubles
  `landed` and the reserved ledger.
- **S1b-14 — no storage conformance contract.** Ten guarantees the in-memory `Storage`
  silently over-delivers, enumerated: atomic-per-record append, ack==durable, read order ==
  write order, no duplicate delivery (and the fold is not idempotent), unbounded size, and
  more. `CommitFailedError` — the F-27 fix — is **unreachable** with the shipped `Storage`.
- **S1b-15 — the crash matrix does not cover any S1b mechanism.** All 18 positions and the
  sweep construct `new S1Kernel(storage)`: unfenced, unsigned. Zero coverage of writer
  acquisition, epoch transition, MAC write or identity resolution.
- Performance, measured: fold is O(N·L) (0→2.3 ms at L=0, 393 ms at L=32 000);
  `protectionFor` is a linear scan **on the admission path**; `events()` re-parses and
  re-SHAs the whole journal per call (208 ms at 3 602 records) and `fork()` calls it.
