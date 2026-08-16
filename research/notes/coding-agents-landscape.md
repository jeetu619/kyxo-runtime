# Coding-Agent Landscape: Architectural Decomposition of Eight Systems

Research note for the universal-runtime architecture mission. Written 2026-08-15.

## Scope

Eight coding-agent systems, examined for **architectural differences** in: execution loop, context gathering, code search, planning, patch application/editing strategy, verification, delegation, permissions, and state handling:

1. **Gemini CLI** (google-gemini/gemini-cli, v0.56.0-nightly, source inspected at commit of 2026-08-14)
2. **GitHub Copilot cloud agent** (formerly "Copilot coding agent"; docs from the open-source github/docs repo, current main) and **Copilot agent mode in VS Code** (microsoft/vscode-copilot-chat v0.44.0, MIT-licensed source)
3. **OpenCode** (sst/opencode v1.18.18, source at 2026-08-14)
4. **Cline** (cline/cline, VS Code app v4.1.10 + the new Cline SDK monorepo, source + in-repo docs)
5. **Roo Code** (RooCodeInc/Roo-Code v3.53.0, source)
6. **Continue** (continuedev/continue, VS Code extension v1.3.40, source + in-repo docs)
7. **Aider** (Aider-AI/aider, source; last commit 2026-05-22 — development has visibly slowed)
8. **Windsurf/Cascade** (docs/press only; proprietary — all claims labeled accordingly)

Method: shallow git clones of all seven open repositories plus a sparse clone of `github/docs` (`content/copilot`), with direct source inspection; WebFetch/WebSearch for proprietary systems and blog material. Several primary domains (aider.chat, docs.github.com, github.blog, opencode.ai, docs.windsurf.com, cognition.com) were blocked by the network egress proxy; in every such case the same content was obtained from the project's GitHub repository, which is noted in the ledger. Claim labels: FACT (documented), SOURCE-CODE OBSERVATION (SCO — I read the code), OBSERVED BEHAVIOR (OB), INFERENCE (INF), each with HIGH/MEDIUM/LOW confidence where non-FACT.

## Source ledger

| Source | Type | What it evidenced |
|---|---|---|
| Local clone `Aider-AI/aider` (repomap.py, coders/*, base_coder.py, website docs in-repo) | source | Repo-map PageRank, edit formats, reflection loop, architect/editor, lint/test hooks |
| raw.githubusercontent.com/Aider-AI/aider/main/aider/website/docs/repomap.md | official doc (in-repo) | Repo map behavior, `--map-tokens` default 1k, dynamic expansion |
| raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_posts/2024-09-26-architect.md | maintainer blog (in-repo) | Architect/editor rationale + SOTA benchmark claims |
| aider `website/docs/more/edit-formats.md` (local clone) | official doc | whole/diff/diff-fenced/udiff formats defined |
| Local clone `google-gemini/gemini-cli` (packages/core/src: core/client.ts, scheduler/, policy/, agents/, routing/; docs/) | source + docs | Loop, nextSpeakerChecker, loop detection, tool-scheduler state machine, policy engine, subagents, A2A, routing |
| raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/index.md | official doc | Core request/tool flow, history compression, model fallback |
| raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md | official doc | Shadow-git checkpointing mechanics, /restore |
| gemini-cli `docs/core/subagents.md`, `docs/core/remote-agents.md`, `docs/reference/policy-engine.md` (local clone) | official docs | Subagents-as-tools, A2A remote subagents, TOML policy rules |
| Sparse clone `github/docs` → `content/copilot/concepts/agents/cloud-agent/*.md` | official docs | Copilot cloud agent: triggers, Actions environment, research/plan/iterate, risks & mitigations, automations |
| Local clone `microsoft/vscode-copilot-chat` (intents/node/toolCallingLoop.ts, tools/common/editToolLearningService.ts, toolNames.ts, virtualTools/, prompts/node/agent/) | source | ToolCallingLoop + autopilot limits, per-model edit-tool learning, virtual tool grouping, history summarization, per-model prompt snapshots |
| Local clone `sst/opencode` (src/session, tool/, permission/, snapshot/, agent/, acp/, lsp/, server/) | source | Client/server split, agents & permission rulesets, task tool, git snapshot service, LSP-diagnostics-in-edit-results, ACP SDK dependency |
| raw.githubusercontent.com/sst/opencode/dev/README.md | official doc | Build/Plan/General agents, Tab switching, distribution |
| Local clone `cline/cline` (sdk/ARCHITECTURE.md, docs/core-workflows/*.mdx, docs/features/subagents.mdx, apps/vscode) | source + in-repo docs | SDK layering, hub runtime, plan/act, shadow-git checkpoints, parallel research subagents |
| Local clone `RooCodeInc/Roo-Code` (src/core/tools/NewTaskTool.ts, packages/types/src/mode.ts, core/diff/strategies, core/condense, core/checkpoints, assistant-message/NativeToolCallParser.ts) | source | Modes incl. orchestrator prompt, new_task delegation, fuzzy diff strategy, LLM condensing, shadow checkpoints, native tool-call parsing |
| Local clone `continuedev/continue` (core/indexing/README.md, context/retrieval/pipelines, tools/definitions, docs/) | source + in-repo docs | Content-addressed indexing, 4 index types, reranker pipeline, tool set, plan mode |
| WebSearch results incl. contrary.com research, infoq.com, digitalapplied.com, devin.ai blog links | press/secondary | Windsurf Riptide (LLM relevance model), Cognition/Devin merger of docs, SWE-grep Fast Context (8 parallel tool calls, ≤4 turns), Cascade "Flows" |
| WebSearch results incl. morphllm.com, itnext.io, github.blog link titles | press/secondary | Copilot coding agent GA timing (Feb 2026 per third-party), ephemeral Actions container claims |
| Dead ends: aider.chat, docs.github.com, github.blog, opencode.ai, docs.windsurf.com, cognition.com (egress-blocked); `docs/architecture.md` in gemini-cli (moved/404) | — | Noted honestly; all replaced with in-repo equivalents except Windsurf/Cognition primary docs |

## Findings

### 1. Execution loop models

The eight systems fall into four distinct computational models:

**(a) Conversational rewrite loop with bounded reflection (Aider).** Aider has *no tool-calling agent loop at all* in the modern sense. One user message → one model completion whose *output text is the edit* (in a declared edit format), applied by the harness, then an optional bounded "reflection" cycle. SCO/HIGH: `base_coder.py` sets `max_reflections = 3`; failed edit application, lint errors (`auto_lint = True` by default), and test errors (`auto_test = False`, opt-in) each set `self.reflected_message`, which is re-sent as the next user message until the cap. Aider is a *pipeline with a feedback valve*, not an autonomous agent.

**(b) Streaming native-tool-call loop with continuation heuristics (Gemini CLI, Copilot agent mode, OpenCode, Cline, Roo Code, Continue).** All six run the now-canonical loop: build prompt → stream model → execute requested tools → append results → repeat until no tool calls. The interesting differences are in the *termination/continuation policy*:
- SCO/HIGH: Gemini CLI runs an **LLM side-channel "next speaker" check** (`nextSpeakerChecker.ts`): after a model turn with no tool calls, a cheap structured call returns `{reasoning, next_speaker: 'user'|'model'}`; if `model`, the harness injects a literal `"Please continue."` user turn. It also runs a `LoopDetectionService` on every event (turn start + per-chunk `addAndCheck`) that aborts on detected repetition. Both were early docs-described as a "ReAct loop"; the current docs no longer use the term (SCO: no ReAct mention remains in docs/).
- SCO/HIGH: Copilot agent mode has the same idea under the name **autopilot**: `ToolCallingLoop` (base class in `toolCallingLoop.ts`) enforces `MAX_AUTOPILOT_RETRIES = 3` and `MAX_AUTOPILOT_ITERATIONS = 5` on harness-initiated continuations.
- SCO/HIGH: Roo Code tracks `consecutiveMistakeCount` per task and surfaces a `mistake_limit_reached` ask to the human — error-budget-based interruption rather than loop detection.
- SCO/HIGH: Cline's SDK anchors *completion* to an explicit tool: the loop ends when the model calls `submit_and_exit` (SDK analog of classic `attempt_completion`), with a fallback emission at session shutdown (sdk/ARCHITECTURE.md). Termination is a **tool-call contract**, not textual.

**(c) Tool scheduling as an explicit state machine (Gemini CLI, uniquely explicit).** SCO/HIGH: `packages/core/src/scheduler/types.ts` defines tool-call states `validating → scheduled → awaiting_approval → executing → success | error | cancelled`, with a separate confirmation bus, parallel-scheduling tests, hook triggers, and a tool-modifier stage. Other systems have approval flows but none reifies the per-call lifecycle this explicitly.

**(d) Remote pipeline: task → ephemeral VM → draft PR (Copilot cloud agent).** FACT (github/docs): the agent is triggered by issue assignment, `@copilot` PR comments, the agents panel, chat, external integrations, or scheduled/event-driven "automations"; it runs in "its own ephemeral development environment, powered by GitHub Actions," researches the repo, can produce an explicit implementation plan, makes changes on a branch, iterates on review comments, and opens a *draft* PR. The whole loop is asynchronous and artifact-mediated (branch, PR, session log) rather than message-mediated.

**Client/server split.** SCO/HIGH: OpenCode is the purest client/server design in the group: `packages/opencode` hosts an HTTP+WebSocket server (`server/routes`, an `openapi()` export, event projectors) with TUI/desktop/web as clients; sessions live server-side. Cline has converged on the same shape: SCO/HIGH from sdk/ARCHITECTURE.md — a layered stack (`@cline/shared` → `@cline/llms` → `@cline/agents` (stateless loop) → `@cline/core` (stateful orchestration) → host apps), plus a **hub daemon**: a detached process brokering sessions, events, approvals, and schedules over WebSocket, with clients that "attach and detach from shared sessions without stopping the authority runtime." Continue, Roo, and Copilot agent mode remain in-process extensions; Gemini CLI is in-process but ships an experimental `a2a-server` package exposing the agent over A2A (SCO/HIGH).

### 2. Context gathering and code search — the most divergent subsystem

Four genuinely different retrieval philosophies coexist:

- **Static analysis + graph ranking (Aider).** FACT (repomap doc) + SCO/HIGH (repomap.py): tree-sitter extracts definition/reference tags; files become nodes in a `networkx.MultiDiGraph` with reference→definition edges; **personalized PageRank** (personalization boosts chat files and mentioned identifiers; same dict passed as `dangling`) selects the highest-value signatures under a token budget (`--map-tokens`, default 1k, dynamically expanded when no files are in chat). No embeddings anywhere.
- **Indexed hybrid retrieval (Continue).** SCO/HIGH (core/indexing/README.md + code): a content-addressed, branch-aware incremental indexing system (SQLite catalog; compute/delete/addTag/removeTag lists) feeding four artifact indexes — tree-sitter code snippets, SQLite FTS5 full-text, structural chunks, and LanceDB embeddings — consumed by retrieval pipelines with an optional reranker (`RerankerRetrievalPipeline`). Continue is the only system in this set with embeddings in the default architecture.
- **Model-driven retrieval (Windsurf/Cognition).** OB/MEDIUM (press, Contrary Research, Cognition blog titles): Windsurf's "Riptide" is a proprietary LLM trained to score snippet relevance, run as thousands of parallel inference calls — an LLM reranker replacing embedding search. Post-acquisition (Cognition, 2025), the docs describe **Fast Context powered by SWE-grep / SWE-grep-mini**: an RL-trained retrieval *subagent* limited to grep/read/glob, executing up to 8 parallel tool calls per turn over ≤4 turns at ~2,800 tok/s. Retrieval itself has become a small fast agent.
- **Agentic search only (Gemini CLI, OpenCode, Cline, Roo, Copilot agent mode).** These rely on the loop itself using grep/glob/read tools. Two refinements: SCO/HIGH — OpenCode ships a dedicated **`explore` subagent** ("Fast agent specialized for exploring codebases," with caller-specified thoroughness levels quick/medium/very thorough), and Cline ships **parallel read-only research subagents** (`use_subagents`) explicitly framed as context-window protection (FACT, docs/features/subagents.mdx). This is retrieval-as-delegation — the same architectural move as SWE-grep, minus the custom model.

Context *construction* extras: hierarchical instruction files are universal (GEMINI.md / AGENTS.md / .clinerules / rules blocks). SCO/HIGH: Copilot agent mode assembles prompts per-model (test snapshots per model family, e.g. gpt-5-codex variants) with explicit prompt-cache breakpoints; Roo condenses history via an LLM summarization call with a dedicated prompt plus "folded file context"; Gemini core auto-compresses history near token limits (FACT, core docs); OpenCode has `compaction.ts`/`overflow.ts`; Cline documents auto-compact. Copilot agent mode also has **virtual tools** (SCO/HIGH: `virtualToolGrouper.ts`) — when the tool count exceeds limits, tools are clustered under synthetic group-tools the model expands on demand; a context-management technique applied to the *tool schema* rather than messages.

### 3. Planning

- **Dual-mode plan/act is now a convention, implemented as tool filtering.** Cline Plan/Act (FACT, docs: plan mode cannot modify files; history carries over on switch); OpenCode `plan` agent (SCO: a primary agent whose permission ruleset denies edit tools); Continue Plan mode (FACT, docs: "filters the available tools to only include read-only operations"); Roo `architect` mode. In all four, "planning" is *not a different engine* — it is the same loop under a restrictive policy. INF/HIGH: plan mode is a policy profile, not an architectural construct.
- **Roo turns plans into structured artifacts**: SCO/HIGH — the architect mode prompt mandates `update_todo_list`; `new_task` accepts a markdown-checklist `todos` parameter (optionally required via `newTaskRequireTodos`), so plans flow into delegation as data.
- **Copilot cloud agent has a platform-level plan phase**: FACT — "research a repository, create an implementation plan, and make code changes on a branch... iterate before creating a pull request" as separately surfaced products in the agents panel.
- **Aider's planning is a model split, not a mode**: architect/editor (below).
- Gemini CLI has no plan mode in core (approval modes and read-only subagents approximate it) — effectively ABSENT as a first-class construct (SCO/MEDIUM).

### 4. Patch application / editing strategy

This is where harness engineering is densest, and the systems differ most instructively:

- **Aider: edit format as the model's output contract.** FACT (edit-formats doc): `whole` (full file), `diff` (SEARCH/REPLACE conflict-marker blocks), `diff-fenced` (Gemini variant), `udiff` (unified diff, introduced to curb GPT-4-Turbo "lazy coding"), `patch`; chosen **per model** in the model catalog, overridable with `--edit-format`. SCO/HIGH: application is a *fallback ladder* — `editblock_coder.py`: perfect match → whitespace-tolerant → `try_dotdotdots` (elision handling) → leading-whitespace repair → `SequenceMatcher` fuzzy match with 0.8 similarity threshold; `udiff_coder.py`: hunk normalization → direct apply → context/change splitting and partial-hunk application. Failures return structured error prompts ("UnifiedDiffNoMatch...") into the reflection loop.
- **Aider architect/editor: two-model editing pipeline.** FACT (blog) + SCO/HIGH (architect_coder.py): the architect model answers free-form; on confirmation the harness spawns a *second Coder* with `editor_model`, `editor_edit_format`, `map_tokens=0`, and empty history, whose only job is translating the architect's prose into applicable edits. Blog reports SOTA on Aider's benchmark (o1-preview architect + DeepSeek/o1-mini editor, 85%). This is delegation across models within one turn — reasoning and formatting as separate capabilities.
- **Copilot agent mode: learned per-model edit-tool selection.** SCO/HIGH: `editToolLearningService.ts` maintains, per model, a windowed success bitset per edit tool (`replace_string_in_file`, `multi_replace_string_in_file`, `apply_patch`, insert-edit) and answers `getPreferredEditTool(model)`; `didMakeEdit(model, tool, success)` updates the state machine. The harness *measures* which patch dialect each model applies reliably and adapts the exposed toolset. This is the strongest evidence in the whole landscape that patch dialect is a per-model negotiated capability.
- **Roo: single search/replace tool with tunable fuzziness.** SCO/HIGH: `multi-search-replace.ts` — line-hinted search/replace blocks, fuzzy match threshold configurable (default 1.0 = exact), 40 buffer lines of scan context.
- **OpenCode: string-replace `edit` + OpenAI-style `apply_patch`, with LSP verification fused into the edit result** (below).
- **Gemini CLI: `replace`/`write_file` guarded by confirmation + automatic pre-edit checkpoint** (shadow git commit before every approved file-modifying call; FACT, checkpointing doc).
- **Continue: `editFile`/`multiEdit`/`singleFindAndReplace`**, with IDE-side apply (SCO/MEDIUM from tool definitions).
- **Cline historically parsed XML-ish tool blocks from text; Roo now ships a `NativeToolCallParser`** consuming streaming native tool-call deltas with partial-JSON parsing (SCO/HIGH) — the ecosystem has migrated from text-protocol tools to native function calling.

### 5. Verification

A clear split between **in-loop verification** (open-source harnesses) and **platform verification** (Copilot cloud agent):

- Aider: lint-after-edit on by default, tests opt-in; both feed the reflection loop (SCO/HIGH).
- OpenCode: SCO/HIGH — `edit.ts` calls `lsp.touchFile()` then `lsp.diagnostics()` and appends "LSP errors detected in this file, please fix:" to the tool result. Verification is *fused into the edit tool's return value*, giving the model immediate typed feedback with zero extra turns.
- Copilot cloud agent: FACT (risks doc) — agent output is automatically checked by **CodeQL**, new dependencies against the **GitHub Advisory Database** (malware + High/Critical CVSS), and **secret scanning**, without requiring a GHAS license; Actions workflows (CI) do not run until a human clicks "Approve and run workflows"; results appear in session logs. Verification is an *institutional pipeline stage*, outside the model loop.
- Gemini CLI: no default lint/test integration; hooks (docs/hooks/) enable user-defined pre/post-tool verification; loop detection and citation checking are the built-in guards (SCO/MEDIUM).
- Cline/Roo: mistake counters, checkpoint diffs for human review, Roo `debug` mode as a verification persona (SCO/HIGH).
- Windsurf: OB/LOW — docs/press describe automatic lint-error fixing in Cascade flows; unverifiable.

### 6. Delegation

Every system except Aider and Continue now has intra-harness delegation, and the shapes are convergent:

- **Roo (boomerang/orchestrator)**: SCO/HIGH — `orchestrator` mode's prompt directs decomposition into `new_task(mode, message, todos)` calls; the child runs in a target mode; the parent is paused; the child returns *only* its `attempt_completion` result summary, which the prompt names "the source of truth." Context isolation is explicit: instructions passed must be self-contained and "supersede any conflicting general instructions" of the child's mode.
- **OpenCode**: SCO/HIGH — `task.ts` spawns a subagent *session* (`subagent_type` selects an agent definition), with `background: true` async mode and notification on completion, **resumable delegation** (`task_id` continues a prior subagent session), and permissions derived via `deriveSubagentSessionPermission`.
- **Gemini CLI**: FACT (subagents doc) — subagents are "exposed to the main agent as a tool of the same name," with own prompt, restricted tools, independent context window; `@name` forces delegation; built-ins include `codebase_investigator`. Uniquely, **remote subagents speak A2A** (FACT): any compliant A2A agent can be mounted from a Markdown+YAML definition, and the experimental `a2a-server` package exposes Gemini CLI itself as an A2A server (SCO).
- **Cline**: FACT (docs) — `use_subagents` launches parallel *read-only* research agents (no edits, no browser, no MCP, no nesting), each with its own context window and separately tracked token/cost budget rolled into task totals. The SDK layer adds team/multi-session primitives and session lineage metadata (`mode: user | automation | subagent | team`) (SCO/HIGH).
- **Copilot cloud agent**: FACT — "custom agents" (specialized prompt+tool bundles) and "automations" (scheduled/event-triggered runs with per-automation tool allowlists).
- **Aider**: delegation exists only as the architect→editor *model* handoff. Continue: no subagent/task tool exists in the core tool definitions — ABSENT (SCO/HIGH).

INF/HIGH: across five independent implementations, a "subagent" is exactly: *a fresh session + a policy/toolset diff + a prompt, returning a single result message to a paused or notified parent.* No system needed a graph engine to express this.

### 7. Permissions and policy

- **Gemini CLI** has the most formal system: FACT (policy-engine doc) + SCO/HIGH — a **TOML rule engine** (`[[rule]] toolName / commandPrefix / decision = allow|deny|ask / priority`), loaded from `~/.gemini/policies/*.toml`, layered with approval modes, shell-safety analysis (command substitution detection), workspace policies, sandbox integration (macOS Seatbelt / container), and policy integrity checks.
- **OpenCode**: SCO/HIGH — per-agent permission **rulesets** with wildcard matching on `(permission, pattern)` pairs, last-match-wins (`findLast`), default `ask`; session-scoped "always allow" accumulation; agents = permission profiles (build vs plan vs subagents).
- **Copilot cloud agent** enforces permissions **at the credential and platform layer**, not in the harness: FACT — push restricted to a single `copilot/*` branch (or the PR branch when invoked from a PR); "cannot directly run `git push`" (credential design); draft-PR-only; cannot mark ready/approve/merge; requester cannot approve (preserves required-approvals semantics); default-on egress **firewall**; hidden-character filtering of user input against prompt injection; only write-access users can trigger it; signed, co-authored commits with links to session logs.
- Cline: auto-approve permission groups + command guard extension + "yolo" preset (SCO/MEDIUM). Roo: mode-scoped tool groups (a mode's edit group can be restricted, e.g. by file regex) + auto-approval settings (SCO/MEDIUM). Continue: per-tool policies (allow/ask/exclude) in config (FACT, docs/MEDIUM). Aider: interactive confirmation for shell commands and file adds; git is the real safety mechanism — a deliberately thin layer (SCO/HIGH).

### 8. State, checkpointing, durability

The **shadow git repository is the convergent checkpoint mechanism**, independently implemented three-plus times:

- Gemini CLI: FACT — commit into `~/.gemini/history/<project_hash>` before every approved file-modifying tool call, storing file state + conversation + the pending tool call; `/restore` reverts all three; **off by default**.
- Cline: FACT — shadow repo per task, commit after *every* tool use, **on by default**; restore menu offers *Restore Files / Restore Task Only / Restore Files & Task* — files and conversation are independently versioned axes.
- Roo: SCO/HIGH — `RepoPerTaskCheckpointService` shadow git per task.
- OpenCode: SCO/HIGH — a git-based `Snapshot` service (`track/patch/restore/revert/diff`, 7-day prune, 2MB file cap) backing session revert; state is SQL-persisted with server-side event projectors (event-sourced flavor).
- Aider: the *real* repo is the checkpoint store — auto-commit after each successful edit with descriptive attribution, `/undo` to revert (SCO/HIGH).
- Copilot cloud agent: durability = the branch + session logs; the environment is ephemeral by design (FACT).
- Continue: session persistence only; no file checkpointing found — ABSENT (SCO/MEDIUM).

Scheduling/durable execution: Copilot **automations** (FACT) and Cline's hub "scheduled-runtime services" (SCO/HIGH) are the only durable-trigger mechanisms; nobody in this set has replayable durable execution in the Temporal sense — ABSENT everywhere (HIGH).

### 9. Model layer

- SCO/HIGH: Gemini CLI ships a **model router** (`routing/strategies`: composite of override → approval-mode → classifier — including a Gemma-based classifier and a numerical classifier → fallback → default) choosing between Flash/Pro per request, plus quota-triggered fallback. Model choice is a per-request harness decision.
- Aider's model catalog binds per-model edit formats and architect/editor pairings (SCO/HIGH). Copilot agent mode maintains per-model prompt variants and learned edit-tool preferences (SCO/HIGH). Cline's `@cline/llms` isolates provider adapters behind a gateway registry, with model *modalities* separated from provider *operations* (image-gen, transcription fail closed unless declared) (SCO/HIGH).
- OB/MEDIUM: Windsurf trains its own models (SWE-1.x line, SWE-grep) and treats retrieval and coding as different model classes; InfoQ reports an "Arena Mode" comparing models in-IDE (2026-02).

### 10. Protocols

- **MCP**: universal — all eight support MCP servers for tool extension (FACT for each; Copilot cloud agent via repo MCP config, Gemini/OpenCode/Cline/Roo/Continue in config, Windsurf in docs).
- **ACP (Agent Client Protocol)**: OpenCode implements it (`src/acp/`, dep `@agentclientprotocol/sdk` 0.21.0 — SCO/HIGH), letting editors like Zed host it as a headless agent. Cline SDK mentions ACP clients (SCO/MEDIUM).
- **A2A**: Gemini CLI both consumes (remote subagents) and serves (a2a-server) — the only system in this set wired for cross-runtime agent federation (SCO/HIGH).
- Copilot cloud agent's "protocol" is GitHub itself: issues, branches, draft PRs, review comments, Actions logs (INF/HIGH: artifact-mediated agent I/O).

## Architecture decomposition

Layer map across the landscape (P = proprietary, OS = open source, Std = standardized protocol, Prov = provider-specific, Port = portable across models):

| Layer | Gemini CLI | Copilot cloud agent | Copilot agent mode | OpenCode | Cline | Roo Code | Continue | Aider | Windsurf |
|---|---|---|---|---|---|---|---|---|---|
| Product/UI | TUI, IDE companion (OS) | GitHub web/panel (P) | VS Code chat UI (OS in vscode + copilot-chat) | TUI/desktop/web clients (OS) | VS Code/JetBrains/CLI (OS) | VS Code (OS) | VS Code/JetBrains (OS) | CLI/watch mode (OS) | IDE fork (P) |
| Agent/harness | packages/core (OS, Port loop; Prov API) | Actions-hosted runner (P) | copilot-chat ToolCallingLoop (OS, Port) | server sessions (OS, Port) | @cline/agents stateless loop (OS, Port) | Task engine (OS, Port) | core tool loop (OS, Port) | Coder classes (OS, Port) | Cascade (P) |
| Planning/orchestration | subagents + A2A (OS/Std) | research→plan→iterate pipeline (P) | intents (OS) | plan agent, task tool (OS) | plan/act + hub teams (OS) | modes + orchestrator/new_task (OS) | plan mode (OS) | architect/editor (OS) | Flows (P) |
| Context construction | GEMINI.md hierarchy + compression (OS) | AGENTS.md/instructions + code search (P) | per-model prompts, summarization, virtual tools (OS) | compaction + AGENTS.md (OS) | context mgmt + focus chain (OS) | condense + folded files (OS) | 4-index retrieval + rules (OS) | PageRank repo map (OS, Port) | Riptide/Fast Context (P, custom models) |
| Model invocation | Gemini API + router (Prov; router OS) | Copilot backend, model picker (P/Prov) | endpoint provider, BYOK (OS harness, Prov backend) | 75+ providers via catalog (OS, Port) | @cline/llms gateway (OS, Port) | provider adapters (OS, Port) | config-driven models (OS, Port) | LiteLLM-style catalog (OS, Port) | own SWE models + frontier (P) |
| Tool selection/execution | scheduler state machine + policy (OS) | platform tools + MCP allowlists (P) | tool service + learning (OS) | registry + permission rulesets (OS) | tool orchestration + guards (OS) | mode tool-groups (OS) | builtin + MCP policies (OS) | none (edits are output) | Cascade tools + hooks (P) |
| Environment | local FS + sandbox (Seatbelt/container) (OS) | ephemeral Actions VM + firewall (P) | local workspace (OS) | local FS, worktrees (OS) | local FS + hub daemon (OS) | local FS (OS) | IDE workspace (OS) | local FS + git (OS) | local IDE (P) |
| Observation | tool results, LSP via IDE (OS) | session logs, CI results (P) | IDE diagnostics (OS) | LSP diagnostics fused into edit results (OS) | tool results, browser (OS) | tool results (OS) | IDE + viewDiff (OS) | lint/test output (OS) | lint/terminal/user-action observation (P) |
| Verification | hooks, loop detection (OS) | CodeQL + advisory DB + secret scanning + human-gated CI (P, platform) | user review (OS) | LSP in-loop (OS) | checkpoint diff review (OS) | mistake limits, debug mode (OS) | user review (OS) | auto-lint/auto-test reflection (OS) | auto lint-fix claims (P) |
| State update | shadow git + /restore (OS) | branch/PR/logs (P) | chat session (OS) | git snapshots + SQL + projectors (OS) | shadow git per task, on by default (OS) | shadow git per task (OS) | session JSON (OS) | real git auto-commits (OS) | memories + trajectories (P) |

## Precise vocabulary

Definitions as instantiated in this landscape; ABSENT marks systems lacking the concept.

- **Model**: the completion endpoint. Every OSS system treats it as a swappable catalog entry with per-model metadata; Aider and Copilot agent mode attach *edit-dialect* metadata to it; Windsurf/Cognition uniquely train task-specialized models (retrieval vs coding).
- **Model API / adapter**: provider client + normalization. Isolated in dedicated layers: `@cline/llms` (gateway registry), OpenCode provider catalog, Continue config models, Gemini `contentGenerator` wrappers (logging/recording/mapping decorators — SCO). Copilot systems are locked to the Copilot backend (BYOK partial).
- **Agent**: universally *a named configuration* — prompt + toolset + permissions + optional model — not a runtime object. OpenCode `agent/agent.ts` literally schema-tizes it with `mode: primary|subagent|all`; Roo calls it "mode"; Gemini/Cline/Copilot call it agent/custom agent.
- **Agent loop**: §1. One canonical native-tool-call loop (six systems), one rewrite-with-reflection pipeline (Aider), one remote artifact pipeline (Copilot cloud agent).
- **Harness**: the software owning prompt assembly, tool execution, recovery, and state; in every OSS system it is clearly separable from the model and provider (Cline names the split precisely: stateless `agents` loop vs stateful `core`).
- **Context-management system**: repo map (Aider), 4-index retrieval (Continue), compaction/summarization (Gemini, OpenCode, Roo, Cline, Copilot chat), retrieval subagents (Cline, OpenCode, Windsurf), virtual-tool grouping (Copilot chat).
- **Memory system**: instruction-file hierarchies everywhere; Windsurf "memories" and Copilot "copilot-memory" docs exist (P). Cross-session learned memory: largely ABSENT in OSS systems except as rule files the agent edits.
- **Tool runtime**: Gemini's scheduler state machine is the most explicit; OpenCode registry + permission wrapper; Copilot chat tool service with learning; Aider: ABSENT (edits are the output format; only shell-command suggestion exists).
- **Execution environment**: local workspace for all except Copilot cloud agent (ephemeral Actions VM + firewall) and optional sandboxes (Gemini Seatbelt/container).
- **Planner**: prompt-level only. Dual plan/act policy profiles (four systems), plan-as-todo-artifact (Roo), platform plan stage (Copilot cloud). Dedicated planner *component*: ABSENT everywhere.
- **Workflow/graph construct**: ABSENT in all eight. The closest things are Roo's orchestrator prompt pattern, Copilot automations, and Cline hub schedules — all trigger + delegation, never dataflow graphs.
- **State/session model**: session/task with message history; checkpoints via shadow git (3+ systems); OpenCode adds server-side projections; Cline hub adds multi-client attach/detach with an "authority runtime."
- **Delegation mechanism**: subagent = session + policy diff + result message (§6); A2A for cross-runtime (Gemini only); architect→editor for cross-model (Aider only).
- **Protocol usage**: MCP (all); ACP (OpenCode, Cline-SDK); A2A (Gemini); GitHub artifacts (Copilot cloud agent).
- **Capability discovery/negotiation**: mostly ABSENT as an explicit mechanism. The two real instances are MCP tool listing (dynamic discovery) and Copilot chat's *empirical* negotiation — EditToolLearningService measuring per-model edit-tool success. Cline's fail-closed provider operation manifests are declaration-based negotiation (SCO/HIGH).
- **Policy/security layer**: rule engines (Gemini TOML w/ priorities; OpenCode wildcard rulesets), group toggles (Cline/Roo/Continue), platform enforcement (Copilot cloud: credentials, branch scope, firewall, human gates).
- **Durable-execution features**: checkpoint/restore of files+conversation (Gemini, Cline, Roo, OpenCode); scheduled triggers (Copilot automations, Cline hub). Replayable deterministic execution: ABSENT.
- **Event system**: OpenCode server bus + projectors; Cline hub structured streaming lifecycle events (`run.started`, tool start/finish, agent done) with requestId/clientId correlation; Gemini confirmation-bus + stream events; others: internal callbacks only.
- **Observability**: OpenTelemetry (Cline enterprise docs, Gemini telemetry dir — SCO); Copilot cloud session logs + audit log + signed commits; Copilot chat rich telemetry on summarization/tool outcomes (SCO).

## Implications for a universal runtime kernel

1. **The agent loop is thin and convergent; its *continuation policy* is where systems differ.** Next-speaker checks, autopilot caps, loop detectors, mistake budgets, and completion-tools are all small policies over turn events. A kernel should expose loop *events* (turn ended without tool call, repeated output detected, error budget exceeded) and let harness plugins decide continuation — never hard-code the loop shape.
2. **Patch application is a model-conditioned capability requiring negotiation with feedback.** Aider's per-model edit formats and Copilot's EditToolLearningService independently prove that the same logical capability ("edit file") needs per-model dialects *and* runtime success telemetry to pick between them. The kernel's capability model should support multiple providers of one capability with recorded outcome signals — an argument for first-class capability *metrics*, not just registration.
3. **Checkpointing has a de facto standard semantics worth kernelizing**: snapshot = (workspace state, conversation state, pending action), restorable on independent axes (Cline's three restore options). Implemented via shadow git four times independently — the kernel should offer this as a primitive so plugins stop reinventing it, while keeping the storage mechanism (git, CAS, overlayfs) pluggable.
4. **Subagent = session + capability/policy diff.** Five systems converged on the same delegation algebra (fresh session, restricted policy, single result message, optional background + resume-by-id + separate budget). A kernel with sessions, policy scoping, budgets, and events gets subagents, boomerang orchestration, and retrieval agents *for free* — they're configurations, exactly as the mission hypothesizes.
5. **Verification belongs on the event path, at two altitudes.** In-loop verifiers (LSP-diagnostics-fused-into-edit-results, auto-lint reflection) and out-of-loop institutional verifiers (CodeQL/secret-scanning/human-gated CI) are the same abstract thing: observers of artifact-change events that emit findings which either re-enter the loop or gate promotion. The kernel needs artifact-change events plus a gate/promotion concept; verifiers become plugins.
6. **Retrieval must stay out of the kernel.** PageRank maps, 4-index hybrid retrieval, LLM rerankers, RL retrieval subagents, and plain grep coexist because they are workload- and economics-dependent; two of them are themselves agents. Context construction is a capability, not a kernel service — but the kernel's *budget* primitive (map-tokens, per-subagent cost tracking) is what all of them are parameterized by.
7. **Policy engines are convergent enough to standardize**: pattern-matched rules → allow/deny/ask, with priority or last-match-wins, layered (defaults < user < session-approved). Copilot cloud shows the ceiling: real enforcement lives in credentials and network, not prompts — the kernel's policy layer must bind to capability *grants* (what tokens/egress the environment holds), not just tool-call filtering.
8. **Protocol boundaries are already forming at three seams** — tools (MCP), editor-hosting (ACP), agent federation (A2A) — matching exactly the kernel's needed interfaces: capability provider, client surface, and peer delegation. A universal runtime should speak all three at the edges rather than invent replacements.
9. **Client/server with attach/detach is the direction of travel** (OpenCode server, Cline hub authority-runtime, Copilot cloud). The kernel should assume sessions outlive any one client and emit correlatable lifecycle events (Cline's requestId/clientId correlation is a good concrete model).
10. **Nobody built a graph engine.** Across eight competitive systems, zero use DAG/workflow abstractions internally; orchestration is prompts + delegation + triggers. Strong evidence that graphs belong as an optional plugin over kernel primitives (sessions, events, triggers), not in the kernel.

## Open questions

- Copilot cloud agent internals (planner prompts, how "research" phase uses GitHub code search, session-state format) remain proprietary; only the platform contract is documented. How much of its verification pipeline (CodeQL gating) is blocking vs advisory per session?
- Windsurf/Cognition post-merger architecture: how Cascade, Devin, and Fast Context now share a runtime is undocumented; Riptide details rest on press accounts (MEDIUM at best).
- Roo's fuzzy-match default of 1.0 (exact) vs Aider's 0.8 ladder: is there public benchmark evidence on failure-recovery rates for exact-match-with-retry vs fuzzy-apply strategies?
- Gemini CLI's A2A server and Cline's hub both hint at multi-runtime federation — is anyone actually running cross-vendor subagent delegation in production, and what does capability negotiation look like when the peer is a black box?
- Aider development slowed markedly in 2026 (last commit May); does the architect/editor two-model pattern survive anywhere else, or has single-model tool-calling + strong frontier models absorbed its benefit?
- How do the LLM-summarization compaction strategies (Roo condense, Copilot summarized history, Gemini compression) compare quantitatively on task-completion degradation? No system publishes evals of its own compaction.
