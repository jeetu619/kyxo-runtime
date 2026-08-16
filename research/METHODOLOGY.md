# Research Methodology

This program treats architecture research like evidence-based engineering, not opinion writing.
Every research note in `notes/` and every synthesized claim in `docs/` follows the discipline
below.

## Claim labeling

Every substantive claim carries exactly one label:

| Label | Meaning |
|---|---|
| **FACT** | Stated in official documentation or a specification, with a source link |
| **SOURCE-CODE OBSERVATION** | We inspected the actual open-source implementation |
| **OBSERVED BEHAVIOR** | Reproducible or widely-reported behavior that is not documented |
| **INFERENCE** | Our reasoning from evidence; never presented as fact |
| **OUR PROPOSAL** | Design we are proposing; carries no evidentiary weight |

Proprietary internals (e.g., Cursor's server-side orchestration, Codex cloud scheduling) are
never labeled above INFERENCE regardless of how plausible the reconstruction is, and no
low-confidence observation about a proprietary system is allowed to become a foundational
architectural assumption.

## Confidence levels

Non-FACT claims carry a confidence: **HIGH / MEDIUM / LOW**.

## Source ledger

Each research note contains a source ledger table: URL, source type (docs / spec / source /
blog / analysis), and what the source evidenced. Access date for all sources: August 2026
unless noted.

## Conclusion discipline

Significant architectural conclusions in the `docs/` set are stated as:

```
Evidence      — what we saw, with labels
Interpretation— what we take it to mean
Implication   — what it changes in the design
Confidence    — HIGH / MEDIUM / LOW
```

## Vocabulary discipline

The following terms are **not** interchangeable anywhere in this repository. Precise
definitions are established in `docs/05-KERNEL-PRIMITIVES.md` and used consistently:

model, model API, model adapter, agent, agent SDK, agent loop, harness, context-management
system, memory system, tool runtime, execution environment, planner, graph, workflow, state
machine, task runtime, delegation system, multi-agent architecture, protocol, capability
discovery, capability negotiation, policy/security layer, durable execution, event system,
observability, application/product UX.
