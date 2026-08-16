# LangGraph: The Channel/Super-step/Checkpoint Kernel Beneath the Graph

## Scope

This note characterizes LangGraph (langchain-ai/langgraph) as an execution runtime, based on direct inspection of the source tree at commit `644815f9` (2026-08-11, `langgraph==1.2.11`, `langgraph-checkpoint==4.2.0`, `langgraph-prebuilt==1.1.0`, `checkpoint-postgres==3.1.2`, `checkpoint-sqlite==3.1.1`) and of the official documentation source repository (langchain-ai/docs, cloned 2026-08-15). It covers: the Pregel/BSP execution model (channels, super-steps, task planning), the StateGraph compiler, dynamic control flow (Send/Command), checkpointing and durability, interrupts/HITL, time travel, the functional API, subgraphs, streaming, the store/memory subsystem, fault tolerance, the commercial platform layer (LangSmith Deployment / Agent Server), and how agents are layered on top. The key question addressed: what exactly is LangGraph's kernel, what is userland, and where the graph abstraction leaks.

Note on ecosystem naming as of mid-2026: docs have moved from `langchain-ai.github.io/langgraph` to `docs.langchain.com`; "LangGraph Platform" is now branded **LangSmith Deployment**, and its server is the **Agent Server**. LangGraph reached 1.0 on 2025-10-22 and is at 1.2.x as of August 2026.

## Source ledger

| URL / source | Type | What it evidenced |
|---|---|---|
| github.com/langchain-ai/langgraph @ `644815f9` (local clone) | Official source | All SOURCE-CODE OBSERVATIONS below; versions from `libs/*/pyproject.toml` |
| `libs/langgraph/langgraph/channels/base.py` | Source file | `BaseChannel` contract: `get/update/checkpoint/from_checkpoint/consume/finish` |
| `libs/langgraph/langgraph/pregel/_algo.py` | Source file | `prepare_next_tasks` (PULL/PUSH planning), `apply_writes` (deterministic ordering, version bumping), deterministic task-ID derivation |
| `libs/langgraph/langgraph/pregel/_loop.py` | Source file | `PregelLoop.tick/after_tick`, durability branches, `accept_push` (mid-step task injection), resume via `_reapply_writes_to_succeeded_nodes`, drain/graceful shutdown |
| `libs/langgraph/langgraph/pregel/main.py` | Source file | `Pregel` class docstring: actors + channels + BSP plan/execute/update phases; raw Pregel usage examples |
| `libs/langgraph/langgraph/types.py` | Source file | `Durability`, `StreamMode`, `Send`, `Command`, `Interrupt`, `StateSnapshot`, `interrupt()` implementation (scratchpad + RESUME writes) |
| `libs/langgraph/langgraph/graph/state.py` | Source file | StateGraph→Pregel compilation: `attach_node/attach_edge/attach_branch`, `branch:to:` channels, `NamedBarrierValue` joins, reducer→channel mapping |
| `libs/langgraph/langgraph/func/__init__.py` | Source file | `@entrypoint`/`@task` implementation; `PREVIOUS` channel; `entrypoint.final` |
| `libs/checkpoint/langgraph/checkpoint/base/__init__.py` | Source file | `Checkpoint` TypedDict (channel_values/channel_versions/versions_seen), `CheckpointMetadata`, `BaseCheckpointSaver` contract |
| `libs/checkpoint/langgraph/store/base/__init__.py` | Source file | `BaseStore` (put/get/search/batch), `IndexConfig`, `TTLConfig` |
| `libs/sdk-py/langgraph_sdk/_sync/*` | Source files | Platform SDK surface: assistants, threads, runs, crons, store clients |
| `libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py` | Source file | `create_react_agent` as a compiled StateGraph; deprecations pointing to `langchain.agents` |
| `libs/checkpoint-conformance/` | Source dir | Existence of a checkpointer conformance test suite package |
| github.com/langchain-ai/docs (local clone, 2026-08-15) `src/oss/langgraph/pregel.mdx` | Official docs | Runtime doc: actors/channels/BSP phases; DeltaChannel (beta, ≥1.2) |
| docs repo `src/oss/langgraph/checkpointers.mdx` | Official docs | Durability modes `exit`/`async`/`sync` definitions |
| docs repo `src/oss/langgraph/interrupts.mdx` | Official docs | Resume re-executes node from its start; idempotency guidance; warning against `while True` + `interrupt()` |
| docs repo `src/oss/langgraph/use-time-travel.mdx` | Official docs | Replay vs fork semantics; re-execution caveats |
| docs repo `src/oss/langgraph/fault-tolerance.mdx` | Official docs | Retry/timeout/error-handler composition (≥1.2); `RunControl.request_drain()` graceful shutdown |
| docs repo `src/oss/langgraph/persistence.mdx`, `stores.mdx` | Official docs | Checkpointer-vs-store split; store semantic search config |
| docs repo `src/oss/concepts/products.mdx` | Official docs | Official taxonomy: runtime (LangGraph, Temporal, Inngest) vs framework (LangChain) vs harness (Deep Agents, Claude Agent SDK) |
| docs repo `src/langsmith/agent-server.mdx` | Official docs | Agent Server architecture: Postgres persistence, Redis task queue, API-server/queue-worker split, distributed runtime |
| docs repo `src/langsmith/assistants.mdx`, `double-texting.mdx`, `server-a2a.mdx`, `core-capabilities.mdx` | Official docs | Assistants concept; double-texting strategies; A2A + MCP endpoints |
| docs repo `src/oss/python/migrate/langgraph-supervisor.mdx`, `src/oss/langchain/multi-agent/index.mdx` | Official docs | `langgraph-supervisor` no longer maintained; migration to subagents-as-tools |
| changelog.langchain.com (via WebSearch) | Official announcement | LangGraph 1.0 GA 2025-10-22, no breaking changes |
| WebSearch results re: "Agent Frameworks, Runtimes, and Harnesses" (www.langchain.com blog, April 2026) | Search summary (blog blocked by proxy) | LangChain = framework, LangGraph = runtime, DeepAgents = harness positioning; corroborated by local `products.mdx` |

Dead ends: `docs.langchain.com`, `blog.langchain.com`, `langchain-ai.github.io`, `www.langchain.com` are all blocked by this environment's egress proxy. Compensated by cloning the official docs source repo (langchain-ai/docs), which is the same content.

## Findings

### 1. Package topology

SOURCE-CODE OBSERVATION (HIGH): The monorepo splits the runtime into independently versioned packages: `langgraph` (core runtime: `pregel/`, `channels/`, `graph/`, `func/`), `langgraph-checkpoint` (checkpoint base + serde + `store/` + `cache/`), `langgraph-checkpoint-postgres`/`-sqlite` (savers), `langgraph-checkpoint-conformance` (a published conformance test suite for third-party checkpointers), `langgraph-prebuilt` (legacy `create_react_agent`), `langgraph-sdk` (client for the platform API), `langgraph-cli`. The core depends on `langchain-core` (Runnable interface, callbacks, RunnableConfig).

FACT: LangGraph 1.0 went GA 2025-10-22 with "no breaking changes"; the repo is at 1.2.11 (2026-08-11). Docs bill it as a "low-level orchestration framework for building stateful agents."

### 2. The Pregel kernel: channels + super-steps

SOURCE-CODE OBSERVATION (HIGH): The `Pregel` class docstring states the model plainly: "Pregel combines **actors** and **channels** into a single application... following the **Pregel Algorithm**/**Bulk Synchronous Parallel** model," with three phases per step — **Plan** (select actors subscribed to channels updated last step), **Execution** (run all selected actors in parallel; "channel updates are invisible to actors until the next step"), **Update** (apply buffered writes to channels). Execution repeats "until no actors are selected... or a maximum number of steps is reached" (`recursion_limit`, default 25; exceeding it raises `GraphRecursionError`).

SOURCE-CODE OBSERVATION (HIGH): **Channels are the state substrate.** `BaseChannel` (`channels/base.py`, 121 lines) is the entire state abstraction: `get()`, `update(Sequence[Update]) -> bool` ("called by Pregel for all channels at the end of each step... order of updates in the sequence is arbitrary"), `checkpoint()`/`from_checkpoint()` for serialization, plus two lifecycle hooks: `consume()` (called when a subscribed task ran — lets a channel clear itself so a value isn't consumed twice) and `finish()` (called when the run is tentatively ending — lets deferred channels release values). Concrete channels: `LastValue` (default; also `LastValueAfterFinish` for deferred nodes), `Topic` (pub-sub, accumulate/dedupe), `BinaryOperatorAggregate` (reducer channel), `EphemeralValue` (cleared next step), `NamedBarrierValue` (waits for a named set of writers — this is how multi-input joins exist), `AnyValue`, `UntrackedValue`, and `DeltaChannel` (beta, ≥1.2 — stores per-step deltas instead of full values to stop checkpoint size growing linearly with thread length; requires a *bulk* reducer receiving all of a step's writes at once).

SOURCE-CODE OBSERVATION (HIGH): **Task planning is version-vector diffing, not edge traversal.** `prepare_next_tasks` (`pregel/_algo.py`) builds each step's task set from two sources: (a) **PUSH tasks** — one per pending `Send` packet in the reserved `__pregel_tasks` Topic channel; (b) **PULL tasks** — for each candidate node, `prepare_single_task` compares the node's `versions_seen` against current `channel_versions` of its trigger channels; a node runs iff some trigger channel has a version it hasn't seen. An optimization uses a precomputed `trigger_to_nodes` reverse index plus the previous step's `updated_channels` set to avoid scanning all nodes. There is no runtime edge data structure at all.

SOURCE-CODE OBSERVATION (HIGH): **Determinism is engineered in at two points.** (1) Task IDs are derived deterministically — `_uuid5_str`/`_xxhash_str` over `(checkpoint_id, checkpoint_ns, step, node, PUSH/PULL, path...)` — so the same checkpoint always plans tasks with the same identities; an assertion (`task_id == task_id_checksum`) verifies this on resume. (2) `apply_writes` sorts completed tasks by task path before folding their writes into channels ("sort tasks on path, to ensure deterministic order for update application"), then bumps `channel_versions` using a monotonic `get_next_version`, updates each task's `versions_seen`, calls `consume()` on read channels, and calls `finish()` on all channels when no updated channel can trigger another node. Writes to unknown channels are logged and dropped.

SOURCE-CODE OBSERVATION (HIGH): **The loop.** `PregelLoop.tick()` (in `pregel/_loop.py`, ~2000 lines, with sync and async subclasses) plans tasks, emits debug/checkpoint stream events, re-applies any pending writes from a previous run (resume), raises `GraphInterrupt` for `interrupt_before`, and returns whether more steps remain. `PregelRunner` (`_runner.py`) executes the step's tasks concurrently on an executor, with per-task retry (`run_with_retry`), timeouts, and commit callbacks. `after_tick()` folds writes via `apply_writes`, emits `values` events, persists the checkpoint (`_put_checkpoint`), and handles `interrupt_after`. Nodes are executed with a `ChannelRead`-based input view and a `ChannelWrite` writer that *buffers* writes into the task's `writes` deque — the BSP isolation guarantee is that these are only applied at the barrier.

INFERENCE (HIGH): The kernel is therefore precisely: **(named, typed, versioned channels) + (a BSP scheduler that diffs version vectors to plan tasks) + (a checkpoint of channel values/versions/versions-seen per super-step)**. Nodes, edges, graphs, agents are not in the kernel.

### 3. StateGraph is a compiler, not the runtime

SOURCE-CODE OBSERVATION (HIGH): `StateGraph.compile()` lowers the user's graph onto Pregel primitives (`graph/state.py`):

- Each **state key** in the schema becomes a channel: `LastValue` by default; `Annotated[T, reducer]` becomes `BinaryOperatorAggregate`; explicit channel instances (e.g. `DeltaChannel`) pass through (`_get_channels`).
- Each **node** becomes a `PregelNode` triggered by a dedicated `branch:to:{node}` channel — `EphemeralValue` normally, `LastValueAfterFinish` when the node is `defer=True`. Its writers publish the node's returned dict as per-key channel writes.
- A **plain edge** `a → b` compiles to: node `a` gets an extra writer that writes to `branch:to:b`. A **multi-source edge** `[a, b] → c` compiles to a `NamedBarrierValue` channel `join:a+b:c` that only becomes available once both writers have written — the join is a channel type, not scheduler logic.
- A **conditional edge** compiles to an extra writer on the source node that runs the router function against a fresh state read and writes to the chosen targets' `branch:to:` channels (or emits `Send` packets).
- `START` and `END` are virtual: `START` is an `EphemeralValue` channel carrying the input; `END` is just the absence of further writes.

INFERENCE (HIGH): Edges do not survive compilation. "Graph" in LangGraph is a **frontend authoring notation** whose visualization (`_draw.py`) is reconstructed from channel wiring, and whose execution semantics are entirely those of the channel/version kernel. This is the strongest possible internal evidence for "graph-as-strategy": LangGraph itself does not run a graph.

### 4. Dynamic control flow: where the graph leaks

SOURCE-CODE OBSERVATION (HIGH): **`Send(node, arg)`** is a packet written to the reserved `__pregel_tasks` Topic channel; planning turns each pending Send into a PUSH task executed in super-step n+1 with a *caller-supplied private state* (`packet.arg`) rather than the shared graph state. This is the map-reduce/fan-out mechanism: the number of parallel tasks is decided at runtime by node code, invisible to the static topology.

SOURCE-CODE OBSERVATION (HIGH): **`Command(update=..., goto=..., resume=..., graph=...)`** is a value a node can return that combines a state update with routing (`goto` a node name or `Send`), can target the parent graph (`Command.PARENT` — the one sanctioned way to cross a subgraph boundary), and doubles as the resume vehicle (`Command(resume=...)` as *input* to `invoke`). Node writers detect `Command` returns via `_control_branch` and translate `goto` into `branch:to:` channel writes. Since a `Command`'s targets are only known at runtime, `add_node(..., ends=...)` exists purely to help static rendering.

SOURCE-CODE OBSERVATION (HIGH): The functional API's `@task` calls inject tasks **mid-super-step**: `PregelLoop.accept_push` creates a new PUSH task (path `(PUSH, parent_path, write_idx, parent_task_id, call)`) while the step is still running, returning a future to the caller. This deliberately punctures the BSP barrier for the imperative API while keeping deterministic task identity (derived from parent task + write index) so that on resume, saved writes are matched back to re-created tasks and completed tasks are not re-executed.

INFERENCE (HIGH): LangGraph accumulated three escape hatches from the static graph — Send (dynamic fan-out), Command (dynamic goto + cross-graph), and functional-API pushes (no graph at all). Each is implemented as writes to reserved channels or dynamic task injection. The lesson: any static-topology abstraction over an LLM workload grows a dynamic-dispatch backdoor, and LangGraph's kernel absorbed this cleanly *because* the kernel was never really a graph.

### 5. Checkpointing and durability

SOURCE-CODE OBSERVATION (HIGH): The persisted `Checkpoint` (checkpoint lib) is a TypedDict: format version `v`, monotonically-sortable `id` (UUID-like), `ts`, `channel_values` (serialized channel snapshots), `channel_versions` (monotonic per-channel versions), `versions_seen` (per-node map of channel versions consumed — the scheduler's entire memory), and `updated_channels`. `CheckpointMetadata.source` is one of `input` / `loop` / `update` / `fork` with a `step` counter (−1 for the input checkpoint). `CheckpointTuple` adds `pending_writes` — writes from tasks that completed *within a failed/interrupted step*, keyed by task ID, which is what makes partial-step recovery possible without re-running successful parallel branches.

SOURCE-CODE OBSERVATION (HIGH): `BaseCheckpointSaver` is a small storage interface — `get_tuple/list/put/put_writes/delete_thread` (+ async variants) keyed by `thread_id` + `checkpoint_ns` + `checkpoint_id` — with a pluggable `SerializerProtocol` (default `JsonPlusSerializer`, msgpack-backed, with an `EncryptedSerializer` wrapper available). Shipped savers: InMemory, SQLite, Postgres; a published conformance suite tests third-party implementations. The interface is storage-only: all checkpoint *semantics* live in the runtime.

FACT (docs, checkpointers.mdx): Three durability modes: `"exit"` (persist only when the run exits — best performance, no crash recovery mid-run), `"async"` (persist while the next step executes — small crash window; the platform default), `"sync"` (persist before the next step starts). Confirmed in `_loop.py` where `durability != "exit"` gates `put_writes` and per-step checkpoint puts.

FACT (docs, use-time-travel.mdx): **Time travel** = invoking with a prior checkpoint's config (**replay**: "Nodes before the checkpoint are not re-executed... Nodes after the checkpoint re-execute, including any LLM calls... and may return different results") or `update_state` on a prior checkpoint (**fork**: creates a new checkpoint with `source: "fork"` and a diverging branch on the same thread). Checkpoint history is a tree via `parent_config`.

INFERENCE (MEDIUM): LangGraph's durability model is **state-snapshot-per-barrier with a write-ahead side channel (pending_writes)**, not event sourcing. Compared to Temporal-style event-log replay this makes resume cheap (load channels, diff versions) but pushes replay-nondeterminism concerns into user code (see interrupts) and makes checkpoint size proportional to state size — the DeltaChannel beta and `durability="exit"` accumulator paths in `_loop.py` are both patches on that cost.

### 6. Interrupts and human-in-the-loop

SOURCE-CODE OBSERVATION (HIGH): `interrupt(value)` (types.py) reads a per-task `PregelScratchpad` from config; it maintains an interrupt counter per task; if a resume value at that index exists it is returned (also persisting the `RESUME` list as a write), otherwise it raises `GraphInterrupt` carrying an `Interrupt` whose stable `interrupt_id` is derived from the checkpoint namespace. Resume values arrive via `Command(resume=...)` (single value or `{interrupt_id: value}` map) and are stored as `RESUME` pending writes against the *task*.

FACT (docs, interrupts.mdx): "The node restarts from the beginning of the node where the `interrupt` was called when resumed, so any code before the `interrupt` runs again." Multiple `interrupt()` calls in one node are matched to resume values **by call order** ("strict ordering" requirement). The docs warn that `while True` + `interrupt()` in one node causes quadratic/exponential replay, and prescribe: idempotent operations before an interrupt, side effects after it, or side effects in separate nodes. Interrupts require a checkpointer; interrupted runs surface as an `__interrupt__` entry in the stream and in `StateSnapshot.interrupts`.

SOURCE-CODE OBSERVATION (HIGH): Static `interrupt_before`/`interrupt_after` node lists exist as a separate, older mechanism handled in `tick()`/`after_tick()` (raising `GraphInterrupt` at the barrier rather than inside a task).

INFERENCE (HIGH): This is the single largest leak in the abstraction. The durable unit is the super-step; `interrupt()` needs sub-node pause points; the reconciliation chosen is *re-execution of the node body with an injected resume value*, which converts a runtime concern (pausing) into a user-code discipline (idempotency, call-order stability, no loops around interrupts). The functional API's `@task` memoization (saved writes matched by deterministic task ID) is LangGraph's own admission that effect boundaries must be finer than nodes for this to be safe.

### 7. Fault tolerance and caching

FACT (docs, fault-tolerance.mdx; ≥1.2): Per-node, composable in fixed order: `retry_policy` (exception-filtered backoff), `timeout` (`NodeTimeoutError` feeds retries), then `error_handler` (a recovery function receiving a `NodeError`, able to update state and `Command`-route; implemented in the kernel as dynamically scheduled error-handler tasks — visible in `_algo.prepare_node_error_handler_task` and `_loop._resume_error_handlers_if_applicable`, which also persist `ERROR_SOURCE_NODE` markers so a resumed run routes to the handler instead of re-running the failed node). `set_node_defaults` sets these graph-wide. **Graceful shutdown**: `RunControl.request_drain()` stops at the next super-step boundary, raising `GraphDrained` with a saved, resumable checkpoint.

SOURCE-CODE OBSERVATION (MEDIUM): Node-level caching exists: `CachePolicy(key_func, ttl)` + `BaseCache` (in the checkpoint lib; InMemory/Redis) keyed by node identity + hashed input; cached writes short-circuit execution (`match_cached_writes`).

### 8. Functional API

SOURCE-CODE OBSERVATION (HIGH): `@entrypoint` wraps a plain function into a Pregel instance with a single node and reserved channels (`START` input, `END` output, `PREVIOUS`). `previous` (last run's saved value on this thread) is injected via the `PREVIOUS` `LastValue` channel; `entrypoint.final(value=..., save=...)` decouples the returned value from the persisted one. `@task` functions return futures; each call is checkpointed as a task write (see §4) giving **replay-with-memoization**: on resume, completed tasks return saved results instead of re-executing. Docs position this as the API for "durable execution"-style imperative workflows — side effects belong in tasks.

INFERENCE (HIGH): The functional API is a second frontend on the same kernel, and it is semantically the *Temporal-shaped* one: entrypoint ≈ workflow (replayed), task ≈ activity (memoized). That both frontends compile to identical kernel constructs (channels, PUSH tasks, checkpoints) is strong evidence the kernel primitives, not the graph, are the load-bearing design.

### 9. Subgraphs

SOURCE-CODE OBSERVATION (HIGH): A compiled graph added as a node runs in a child checkpoint namespace: `checkpoint_ns` strings compose as `parent|child:task_id` (NS_SEP `|`); by default subgraphs inherit the parent's checkpointer (`Checkpointer = None | bool | BaseCheckpointSaver` — `True`/`False` to force/disable own persistence). Subgraph state lives in its own namespaced checkpoints (docs troubleshooting: "each subgraph manages its own checkpoint namespace"); crossing boundaries is via shared state keys, `Command.PARENT`, or the store. `RemoteGraph` (`pregel/remote.py`) implements the same `PregelProtocol` over the platform API so a deployed graph can be mounted as a subgraph.

### 10. Streaming

SOURCE-CODE OBSERVATION (HIGH): `StreamMode = "values" | "updates" | "checkpoints" | "tasks" | "debug" | "messages" | "custom"` (types.py). `values` emits full state after each step; `updates` per-node deltas; `checkpoints`/`tasks`/`debug` expose the runtime's own lifecycle; `messages` emits LLM tokens from inside nodes (intercepted via langchain-core callbacks); `custom` exposes a `StreamWriter` injected into nodes. Streaming propagates through subgraphs (`subgraphs=True` yields namespaced chunks). Internally a `StreamProtocol`/`DuplexStream` object rides in the config; emission happens in-loop (`_emit`).

### 11. Memory: checkpointer vs store

FACT (docs, persistence.mdx): Two complementary systems: **checkpointers** (thread-scoped short-term memory: state snapshots) vs **stores** (cross-thread long-term memory: application key-value data). SOURCE-CODE OBSERVATION (HIGH): `BaseStore` (checkpoint lib) is a namespaced (tuple-path) key-value interface — `put/get/search/list_namespaces` over `Item`s, batchable — with optional `IndexConfig` (embedding model + dims + field selectors) enabling **semantic search** (`store.search(namespace, query=...)`), and `TTLConfig`. The store is injected into every task at runtime (visible in `prepare_*_task` runtime override). Postgres-backed on the platform.

INFERENCE (MEDIUM): "Memory" in LangGraph is storage infrastructure only — extraction, summarization, or retrieval *policy* lives in userland (docs point to patterns and to LangMem/DeepAgents).

### 12. The platform layer: LangSmith Deployment / Agent Server

FACT (docs, agent-server.mdx and neighbors): The commercial layer wraps any compiled Pregel (or even non-LangGraph agents via a functional-API wrapper) in a server exposing: **Assistants** (versioned configurations of a deployed graph — "not available in the open source library"), **Threads** (persistent state containers), **Runs** (executions of an assistant on a thread; background runs, stateless runs, custom run IDs), **Crons** (scheduled runs), **webhooks**, and streaming endpoints. Architecture: API servers (no agent code execution) + queue workers (execute graphs, write checkpoints) over **Postgres** (all durable data: assistants/threads/runs/crons/checkpoints/store) and **Redis** (ephemeral pub-sub + signaling only); three modes — single host, split API/queue, and a "distributed runtime" separating orchestration from execution. **Double-texting** policies on concurrent input to a running thread: `enqueue` (default), `reject`, `interrupt`, `rollback` — a platform feature, not OSS. The server auto-injects checkpointer/store ("Do not configure these in your graph code").

FACT (docs, server-a2a.mdx, core-capabilities.mdx): The Agent Server exposes each assistant over **A2A** (`/a2a/{assistant_id}`, with `/.well-known/agent-card.json` discovery) and as **MCP** tools — protocol adapters at the platform boundary, absent from the OSS runtime.

INFERENCE (HIGH): The platform is a control plane grafted onto the kernel through the checkpoint contract: because a run's entire progress is a row-set of checkpoints keyed by thread, stateless queue workers can pick up, resume, interrupt, roll back, or fork any run. Assistants/threads/runs/crons are *not* kernel concepts; they are addressable wrappers around (graph, config), (thread_id), (one loop execution), and (scheduled run creation) respectively.

### 13. Agents and multi-agent as userland

SOURCE-CODE OBSERVATION (HIGH): `create_react_agent` (langgraph-prebuilt) is literally a small StateGraph: an `agent` node (model call), a `tools` node (`ToolNode`), and a conditional edge `should_continue` that either routes to tools (as `Send`s in v2) or ends. Its types now carry deprecation warnings pointing to `langchain.agents` — LangChain 1.0's `create_agent` (with middleware) is the successor, "built on top of LangGraph" (products.mdx).

FACT (docs, migrate/langgraph-supervisor.mdx): The `langgraph-supervisor` package (and by ecosystem association `langgraph-swarm`) "is no longer actively maintained"; the recommended replacement is the **subagents pattern**: "a main agent coordinates specialized workers by calling them as tools." The multi-agent docs enumerate patterns — subagents, handoffs (state-driven), skills, router, custom workflow — with graph-based "custom workflow" as the fall-through case, and point to **Deep Agents** as the packaged harness (planning, virtual filesystem, subagents, summarization) on top.

INFERENCE (HIGH): This is a significant evolution: multi-agent-as-graph-topology (supervisor/swarm graphs, 2024–2025) lost to multi-agent-as-tool-calls, where coordination is delegated to the LLM's tool-calling rather than encoded in edges. The graph survives underneath as the *durability and state substrate*, not as the coordination language.

### 14. Official self-positioning

FACT (docs, products.mdx; blog "Agent Frameworks, Runtimes, and Harnesses," April 2026): LangChain's own taxonomy: **agent runtimes** (LangGraph, alongside Temporal and Inngest) provide durable execution, streaming, HITL, persistence; **agent frameworks** (LangChain, Vercel AI SDK, OpenAI Agents SDK, ADK...) provide abstractions; **agent harnesses** (Deep Agents SDK, Claude Agent SDK, Manus) provide batteries-included tools/prompts/subagents. "LangChain 1.0 is built on top of LangGraph."

## Architecture decomposition

| Layer | In LangGraph | Status |
|---|---|---|
| Product/UI | LangSmith Studio, Agent Chat UI, LangSmith tracing UI | Proprietary (Studio/LangSmith); OSS chat UI exists |
| Agent/Harness | Deep Agents SDK; LangChain `create_agent` + middleware; prebuilt `create_react_agent` | Open source, userland packages on top of the kernel |
| Planning/orchestration | None in-kernel (no planner). Orchestration = user topology (StateGraph/entrypoint) + LLM tool-calling decisions in agent loops | Open source; user-defined; portable in structure, not in artifact |
| Context construction | ABSENT from kernel. Userland: message reducers (`add_messages`), LangChain middleware (summarization etc.), Deep Agents context management | Open source, userland |
| Model invocation | ABSENT from kernel — a node is an opaque callable. LangChain chat-model integrations typically used inside nodes; `messages` stream mode hooks their callbacks | Provider-specific, via LangChain integrations; kernel is model-agnostic to the point of not knowing models exist |
| Tool selection/execution | ABSENT from kernel. `ToolNode`/LangChain tools in userland; MCP client support via `langchain-mcp-adapters` | Open source userland; MCP standardized at the edges |
| Environment | ABSENT. No sandbox, no filesystem/compute abstraction; nodes run arbitrary Python in-process | — |
| Observation | Streaming modes (`values/updates/messages/custom/tasks/checkpoints/debug`) emitted by the loop | Open source, kernel feature |
| Verification | ABSENT from kernel (no output validation/guardrails); userland middleware or nodes | — |
| State update | The kernel itself: channels + reducers + `apply_writes` + checkpoint per super-step | Open source; the kernel |
| Durable execution/control plane | OSS: checkpointers, durability modes, drain. Platform: threads/runs/crons/double-texting on Postgres+Redis | OSS core; proprietary control plane (self-hostable, licensed) |
| Protocols | OSS runtime: none (Python API). Platform boundary: HTTP API (SDK), MCP, A2A | Provider-specific API + standardized MCP/A2A adapters |

## Precise vocabulary

- **Model**: ABSENT as a runtime concept. Any LLM lives inside node code (typically a LangChain `ChatModel`). The kernel sees only callables and channel writes.
- **Model API / adapter**: LangChain integration packages (`langchain-openai`, etc.) — outside LangGraph proper. The `messages` stream mode is the only place the kernel acknowledges LLMs, by tapping langchain-core callbacks.
- **Agent**: userland pattern — a compiled graph whose loop is model-call → tool-execution → repeat (`create_react_agent`, LangChain `create_agent`). On the platform, "assistant" = versioned configuration of a deployed graph.
- **Agent loop**: a cycle in the compiled channel topology (agent ⇄ tools), executed as alternating super-steps; bounded by `recursion_limit`.
- **Harness**: explicitly named in LangChain's taxonomy; Deep Agents SDK is their harness on LangGraph. LangGraph itself is *not* a harness.
- **Context-management system**: ABSENT in kernel; reducers + userland middleware.
- **Memory system**: two-tier infrastructure — checkpointer (thread-scoped state snapshots) + `BaseStore` (cross-thread namespaced KV with optional embedding-indexed semantic search). Policy is userland.
- **Tool runtime**: ABSENT in kernel; `ToolNode` in prebuilt/LangChain executes tool calls (parallel by default) inside one node.
- **Execution environment**: the host Python process (or platform queue worker container). No sandboxing.
- **Planner**: ABSENT (no built-in planning; Deep Agents adds todo-list planning as tools).
- **Workflow/graph construct**: `StateGraph` (declarative) and `@entrypoint/@task` (imperative) — both **frontends compiling to Pregel**; the runtime construct is `Pregel` (channels + `PregelNode`s with trigger subscriptions).
- **State/session model**: state schema → channels; session = **thread** (`thread_id`) = a checkpoint lineage (a tree, via forks); `StateSnapshot` is the read model.
- **Delegation mechanism**: subgraphs (namespaced checkpoints), `Send` (dynamic parallel task spawn with private state), `Command(graph=PARENT)` (child→parent transfer), subagents-as-tools (current recommended multi-agent pattern), `RemoteGraph` (network delegation via platform API).
- **Protocol usage**: OSS core: none. Platform: HTTP/SSE API, MCP (expose assistants as tools), A2A (message/send, message/stream, tasks/get + agent cards).
- **Capability discovery/negotiation**: ABSENT in OSS. A2A agent cards at the platform boundary are the only discovery surface.
- **Policy/security layer**: essentially ABSENT in OSS (no permissions, no sandbox; serde-level encryption hook exists). Platform adds auth/custom-auth middleware. HITL interrupts are the de facto authorization mechanism.
- **Durable-execution features**: checkpoint per super-step; `pending_writes` for partial-step recovery; durability modes sync/async/exit; task memoization (functional API); replay/fork time travel; drain; per-node retry/timeout/error-handler; node caching.
- **Event system**: streaming modes are the event bus (loop-emitted); plus langchain-core callbacks; platform adds Redis pub-sub, webhooks, crons.
- **Observability**: LangSmith tracing (proprietary SaaS) via langchain-core callback instrumentation; OSS side has `debug/tasks/checkpoints` stream modes and OTEL-ish integrations through LangSmith.

## Implications for a universal runtime kernel

1. **The strongest "graph runtime" in the ecosystem does not run a graph.** LangGraph's kernel is channels + version-vector scheduling + barrier checkpoints; StateGraph and the functional API are both compilers onto it. A universal kernel should likewise make *graph a strategy/frontend*, keeping the kernel at the level of typed state cells, task planning, and checkpoints — LangGraph is existence proof that two very different authoring models (declarative graph, imperative durable-function) share one such kernel with full fidelity.
2. **Merge policy belongs to state, not to actors.** Reducers attached to channels (schema-level) are what make parallel fan-out, Send-based map-reduce, and deterministic write-folding safe. A kernel that lets concurrent tasks write raw state forces either locks or last-writer-wins; LangGraph shows "CRDT-lite" typed channels are the cheap, sufficient alternative.
3. **Checkpoint = state snapshot + version vectors is a viable alternative to event sourcing** — resume is O(state) not O(history), and time-travel/forking falls out naturally — but it has known costs LangGraph is still patching: checkpoint size ∝ state size (hence DeltaChannel beta), and sub-step effects need a separate write-ahead channel (`pending_writes`). A universal kernel should probably treat "snapshot + pending effect log" as one composite durability primitive from day one.
4. **The durability quantum must be finer than the actor.** `interrupt()` resuming by re-running the node body — with documented idempotency disciplines and an exponential-replay footgun — is the price of making the super-step the only durable boundary. The functional API's memoized `@task` is the correction. Kernel lesson: effects need first-class identity (deterministic task/effect IDs) so pause/resume never re-executes completed side effects.
5. **Deterministic task identity is the linchpin of resumability.** Everything — resume, memoization, error-handler routing, fork replay — hangs off task IDs derived from (checkpoint id, namespace, step, node, path). A universal kernel needs an equally principled effect-addressing scheme.
6. **Dynamic dispatch always wins.** Send, Command(goto), mid-step `accept_push`, and the ecosystem's pivot from supervisor-graphs to subagents-as-tools all show control flow migrating from static topology into runtime decisions (often the LLM's). The kernel should natively support dynamic task spawning with private state; static topology is a UX/verification layer, not an execution requirement.
7. **The control plane composes through the checkpoint contract.** Assistants/threads/runs/crons/double-texting/A2A/MCP are all built *outside* the kernel, enabled solely by the fact that a run's full progress is externalized storage keyed by thread. A universal kernel that nails the checkpoint contract gets its distributed platform "for free" as stateless workers + a queue + a database — LangGraph's Agent Server is exactly that shape.
8. **What LangGraph leaves absent maps the remaining kernel surface**: no model abstraction, no tool runtime, no sandbox/environment, no policy/permissions, no capability negotiation, no budgets. In a capability-oriented universal runtime these become first-class kernel citizens; in LangGraph they are userland or platform add-ons, and the security story in particular is thin (in-process arbitrary Python, HITL as the only guardrail).
9. **Version the storage format, conformance-test the interface.** `Checkpoint.v`, checkpoint migrations in the compiler (`_migrate_checkpoint`), and a published checkpointer conformance suite are operationally mature moves worth copying for any kernel with pluggable persistence.

## Open questions

- DeltaChannel is beta and changes the checkpoint contract (per-channel counters, ancestor-walk reconstruction, bulk reducers): does the stable form move LangGraph toward a hybrid snapshot/event-log model, and does the `BaseCheckpointSaver` interface survive it?
- How far does replay determinism actually hold in production graphs (fork + re-executed LLM calls diverge by design) — is fork-based time travel used for debugging only, or for live branching workloads?
- The functional API's mid-step `accept_push` breaks BSP purity (tasks scheduled during a step) — what are the precise consistency semantics between a pushed task's writes and the enclosing step's barrier, especially under `durability="exit"`?
- Multi-language parity: LangGraph.js (`@langchain/langgraph`, separate repo) re-implements the kernel — are checkpoint formats cross-compatible between Python and JS runtimes on the same thread?
- The distributed runtime mode (separating orchestration from execution processes) is documented but not open source — what protocol does the orchestrator use to drive remote task execution, and could a checkpoint-native task protocol standardize this?
- With LangChain `create_agent` + Deep Agents pulling nearly all users above the graph, does the StateGraph frontend remain load-bearing, or does LangGraph converge on "durable-execution engine with an agent-shaped SDK" (i.e., the Temporal comparison made in their own docs becoming literal)?
