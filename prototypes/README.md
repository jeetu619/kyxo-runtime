# Prototypes — NOT production code

Nothing in this directory is the Kyxo Runtime implementation. There is no production
runtime yet: it is created only after the record-format freeze (`docs/22`), which has not
happened.

Everything here exists to **falsify architecture**. A prototype that never broke anything
was a waste of time; these broke ten things (`docs/20-SEMANTIC-TEST-RESULTS.md`).

## What each directory is

| Directory | Phase | Status | What it is |
|---|---|---|---|
| `kernel/` | 1 | **Disposable** | Universality demo: eight heterogeneous constructs through one invocation path, with a grep gate proving the kernel never branches on capability identity. Its provider contract is **superseded** — it hands capabilities a live kernel handle, which is exactly the commit-barrier bypass phase 2 removed (ADR-017) |
| `harness/` | 1 | **Disposable** | Two harness behaviours over one model, set-identical at the kernel boundary |
| `graph/` | 1 | **Disposable** | Dynamic graph with evidence-provenanced mutation |
| `loop/` | 1 | **Disposable** | Bounded loop with five distinct termination paths |
| `kernel-semantics/` | 2 | **Semi-disposable — executable specification** | The normative semantics of `docs/17`–`19` made executable: structural commit barrier, uncertainty, fork/dedup/grants, crash matrix, property and differential suites. **Its semantics survive into production; its code does not** |

## Rules

1. **No production package may ever import from `prototypes/`** (invariant C11,
   `docs/23` §10). This will be enforced by an import-graph lint once `packages/` exists.
2. **Where prototype code and the normative documents disagree, the code wins** and the
   document is corrected — that is what these are for. Ten such corrections are recorded in
   `docs/20`.
3. **Do not "promote" a prototype file into production.** The production kernel is written
   against the frozen record format, informed by these experiments, not copied from them.
   `kernel-semantics/` in particular carries known defects catalogued in `docs/22` §2.

## Running them

```bash
cd prototypes
npm install
npx tsc --noEmit                                                          # type-check
node --experimental-strip-types --test kernel-semantics/tests/*.test.ts   # 46 semantic tests
bash kernel/validate.sh                                                   # phase-1 gates
KYXO_FUZZ_SEEDS=1000 KYXO_FUZZ_LENGTH=70 \
  node --experimental-strip-types kernel-semantics/fuzz.ts                # extended fuzz
```

Zero runtime dependencies; Node ≥ 22; TypeScript strict.
