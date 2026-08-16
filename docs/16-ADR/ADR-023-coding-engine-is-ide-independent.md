# ADR-023 — The coding engine is IDE-independent; IDEs are clients

Status: **Accepted** (2026-08-16). Scope: the future `kyxo-code` consumer. Related:
ADR-022 (runtime/consumer boundary), ADR-005 (harness as behaviour contract),
`docs/23-REPOSITORY-AND-CONSUMER-ARCHITECTURE.md` §8.2, §14.

This ADR is recorded now, before any implementation, because the decision is
architecturally significant and is cheapest to hold before the first client exists.

## Context

The obvious way to ship an AI coding product is a VS Code extension: it is where the users
are, the extension API provides editor state for free, and shipping is a marketplace
upload. The equally obvious consequence is that the extension host becomes the engine's
runtime, and the product acquires an editor-shaped architecture it cannot leave.

The research base is unusually clear on this. Every coding system that reached
multi-surface maturity converged on the same shape: an engine process with a client
protocol, and editors as thin clients. Codex runs one Rust core behind a submission/event
protocol serving CLI, IDE, desktop and web. Cursor exposes one agent runtime through five
surfaces and speaks ACP so other editors can host it. OpenCode is server-first with
attach/detach clients. Cline rebuilt itself as a stateless loop plus a detached hub daemon.
(SOURCE-CODE OBSERVATION / FACT, HIGH — `research/notes/openai-agents-sdk-codex.md`,
`cursor.md`, `coding-agents-landscape.md`.)

The counter-evidence is instructive too: Cursor's shadow workspace — a hidden Electron
window used to give background AI lint feedback — was removed once its role could be served
without an editor in the loop. Editor coupling was a cost, not a capability.

## Decision

**Kyxo Code is an engine process. IDEs, CLIs and web surfaces are clients of that engine
over a client protocol. The engine never imports an editor API.**

1. **The engine owns coding intelligence**: repository discovery and indexing, code context
   construction, patch construction and edit dialects, git operations, build/test/lint
   integration, coding harnesses, coding verification policy.
2. **Clients own presentation and local user state**: UI, editor selection and open files,
   diff rendering, approval interaction, commands, event display.
3. **Editor state enters the engine as data, never as a dependency.** "Current file" and
   "selection" are parameters of an objective, not an API the engine calls back into.
4. **The first client is the CLI**, not VS Code. If the CLI cannot drive a workflow, the
   engine's contract is incomplete — an editor's convenience must never be load-bearing.
5. **The client protocol is JSON-RPC 2.0**: stdio for local, WebSocket for remote, with the
   same message framing both ways so local and cloud clients are identical code.
6. **The protocol exposes workspaces, objectives, diffs, approvals and events — never
   kernel internals.** No journal, grant, binding or checkpoint concept crosses it.
7. **The engine is a runtime consumer**, integrating through the same SDK any third party
   uses (ADR-022).

## Alternatives considered

**A. VS Code extension first, extract the engine later.** Fastest path to a demo and the
most commonly attempted. Rejected on the evidence of what "extract later" costs: once
editor lifecycle, activation events and workspace APIs are load-bearing, extraction is a
rewrite, and the CLI/JetBrains/web surfaces are indefinitely deferred. The systems cited
above all ended up at the engine-plus-protocol shape; the ones that started there paid less
for it.

**B. Engine inside the runtime.** Rejected by ADR-022 — coding intelligence in a generic
runtime forfeits the substrate argument and makes every non-coding consumer second-class.

**C. Multiple engines, one per surface.** Rejected outright: coding intelligence would
diverge per client, and the model×harness benchmark profile (doc 10) would become
meaningless because "the harness" would differ by editor.

**D. Adopt an existing editor-agent protocol (ACP) instead of defining one.** Not rejected
— deferred and preferred where it fits. If ACP or a successor covers the surface, Kyxo Code
should speak it rather than invent a dialect (ADR-007's project-don't-invent principle
applied one layer up). The decision here is the *shape* (engine + protocol), not the
ownership of a new protocol.

## Consequences

**Positive.**
- New surfaces are client work, not engine work: JetBrains, web, CI and automation become
  incremental.
- Local and remote execution can present identically, because clients already speak a
  protocol rather than sharing a process (doc 23 §14).
- The engine is testable headlessly, which is what makes harness×model benchmarking
  possible at all.
- Editor deprecation is survivable — the §12.3 test in doc 23 passes by construction.

**Negative (real, and accepted).**
- **Slower first demo.** A protocol plus a CLI plus an extension is more work than an
  extension, and the difference is visible to stakeholders early.
- **Some editor-native experiences are harder.** Inline ghost-text completion and other
  latency-critical, deeply editor-integrated features fit an extension better than a
  protocol client; those may legitimately live in the client, and the boundary will be
  argued case by case.
- **A protocol is a compatibility obligation** once external clients exist — which is why
  it must not be frozen before the runtime's public protocol (doc 23 §9).
- **Two hops for local users** (client → engine → runtime) adds latency that a fused design
  would not pay.

## Evidence and confidence

- FACT / SOURCE-CODE OBSERVATION (HIGH): four independent systems converged on
  engine-plus-client-protocol; one removed its editor-coupled component.
- OBSERVED BEHAVIOR (MEDIUM): the shadow-workspace removal is reported behaviour rather
  than documented rationale.
- Confidence **HIGH** on the engine/client split; **MEDIUM** on JSON-RPC specifically —
  the framing choice should be revisited against ACP maturity when the protocol is actually
  designed, which this ADR explicitly does not do.
