# Model Context Protocol (MCP): Deep Protocol Study — Revision 2026-07-28

## Scope

This note is a deep protocol study of the Model Context Protocol as of **2026-08-15**. The current specification revision is **2026-07-28** (released July 28, 2026), which is a major architectural pivot from the previous revisions (2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 → 2026-07-28). The study covers: the client/host/server architecture; the (now removed) initialize handshake and its replacement — per-request capability declaration plus `server/discover`; the exact `ClientCapabilities`/`ServerCapabilities` objects; server primitives (tools, resources, prompts); client features (sampling, elicitation, roots — two of three now deprecated); the Multi Round-Trip Request (MRTR) pattern that replaced server-initiated requests; the Tasks extension for long-running work; transports; authorization; the versioning/feature-lifecycle/extension machinery; MCP Apps; the registry; and governance. The final sections extract MCP's capability-contract mechanisms as candidate patterns for our runtime kernel and map what MCP deliberately does not cover.

Primary evidence is the official spec repository (`modelcontextprotocol/modelcontextprotocol`), cloned at commit `4df2d6b` (2026-08-14) — I read the actual `.mdx` spec sources, `schema.ts`, SEP documents, and governance files. Claims from those files are labeled FACT (they are the normative documentation) or SOURCE-CODE OBSERVATION (schema internals). Analysis is labeled INFERENCE.

## Source ledger

| Source | Type | What it evidenced |
| --- | --- | --- |
| Web search "Model Context Protocol specification latest revision 2026" | search | Established 2026-07-28 as current revision; surfaced blog + changelog links |
| https://blog.modelcontextprotocol.io/posts/2026-07-28/ | official blog (fetched) | Release summary: stateless core, MRTR, header routing, cacheable lists, auth hardening, extensions framework, SDK tiers; SEP numbers |
| https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/ | official blog (fetched) | 2026 roadmap: transport evolution, tasks retry/expiry, governance delegation, enterprise extensions; explicit scope limits |
| https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx | spec source (fetched) | Full 2026-07-28 changelog: 9 major + 12 minor changes + deprecations, with SEP numbers |
| https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/changelog.mdx | spec source (fetched) | 2025-11-25 changelog: tasks (SEP-1686), CIMD (SEP-991), icons (SEP-973), sampling tools (SEP-1577), elicitation URL mode (SEP-1036), governance SEPs |
| git clone github.com/modelcontextprotocol/modelcontextprotocol @ 4df2d6b (2026-08-14) | official repo (cloned; files read locally) | Everything below: `docs/specification/2026-07-28/**` (basic/index, versioning, patterns/mrtr, patterns/subscriptions, transports/streamable-http, transports/stdio, authorization/index, server/discover, server/tools, server/utilities/caching, architecture/index, deprecated.mdx), `schema/2026-07-28/schema.ts`, `docs/extensions/**` (overview, tasks, apps), `docs/registry/about.mdx`, `docs/community/feature-lifecycle.mdx`, `docs/community/sep-guidelines.mdx`, `GOVERNANCE.md`, `seps/2577-*.md`, `seps/1865-*.md` |
| Dead end: https://modelcontextprotocol.io/* | official docs site | Blocked by network egress proxy; all content obtained from the repo sources instead (same content, pre-render) |
| Dead end: api.github.com contents API | API | 403 via proxy; worked around with full clone |

## Findings

### 1. Revision history and the shape of the current protocol

- FACT. Spec revisions to date: **2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28**, plus a rolling `draft`. `schema/2026-07-28/schema.ts` line 30: `export const LATEST_PROTOCOL_VERSION = "2026-07-28"`.
- FACT. **2025-11-25** (vs 2025-06-18) added: experimental **Tasks** framework (SEP-1686); OAuth **Client ID Metadata Documents** as recommended registration (SEP-991); OIDC Discovery; incremental scope consent via `WWW-Authenticate` (SEP-835); icons on tools/resources/prompts (SEP-973); **sampling with tools** (`tools`/`toolChoice` params, SEP-1577); URL-mode elicitation (SEP-1036); elicitation enum/default redesign (SEP-1330, SEP-1034); JSON Schema 2020-12 as default dialect (SEP-1613); formal governance (SEP-932), working groups (SEP-1302), SDK tiering (SEP-1730).
- FACT. **2026-07-28** (vs 2025-11-25) is a breaking architectural pivot: protocol-level sessions removed (SEP-2567); `initialize`/`notifications/initialized` handshake removed — every request carries version + capabilities in `_meta` (SEP-2575); mandatory `server/discover` RPC (SEP-2575); server-initiated requests replaced by **MRTR** (SEP-2322); `resources/subscribe`+HTTP GET replaced by `subscriptions/listen` (SEP-2575); `ping`, `logging/setLevel`, `notifications/roots/list_changed` removed; SSE resumability and `Last-Event-ID` **removed**; tasks moved out of core into the `io.modelcontextprotocol/tasks` extension (SEP-2663); `Mcp-Method`/`Mcp-Name` HTTP headers required (SEP-2243); cacheable list/read results via `ttlMs`/`cacheScope` (SEP-2549); `resultType` field required on all results (SEP-2322); roots/sampling/logging **deprecated** (SEP-2577); DCR deprecated in favor of CIMD; error-code range partitioned (`-32000..-32019` legacy, `-32020..-32099` spec-reserved).
- INFERENCE (HIGH). The trajectory is unmistakable: MCP moved from a *stateful bidirectional session protocol* (2024–2025) to a *stateless request/response protocol with explicit handles* (2026), driven by horizontal-scaling and gateway deployment pressure. This is the single most important architectural datapoint for our kernel: the ecosystem's flagship protocol found stateful sessions untenable at scale and re-based everything on (a) self-describing requests and (b) explicit durable handles.

### 2. Host / client / server architecture

- FACT (architecture/index.mdx). MCP is a **client-host-server** architecture: the *host* is the container process (creates/manages clients, enforces security policy and consent, coordinates LLM integration, aggregates context); each *client* has a strict 1:1 relationship with one *server*; *servers* expose resources/tools/prompts and "operate independently with focused responsibilities."
- FACT. Design principles stated normatively: (1) "Servers should be extremely easy to build" — hosts absorb orchestration complexity; (2) servers should be highly composable; (3) "Servers should not be able to read the whole conversation, nor 'see into' other servers" — full conversation history stays with the host; cross-server interaction is host-mediated; (4) features are added progressively via capability negotiation.
- INFERENCE (HIGH). MCP's isolation principle (#3) is a *capability-confinement* stance: a server is a confined capability provider, and the host is the trusted policy kernel. This is exactly the kernel/plugin split our runtime is investigating — MCP already draws the line at "context construction and policy live in the host; execution lives in servers."

### 3. Capability negotiation after the stateless pivot (the heart of this study)

**The old model (2024-11-05 → 2025-11-25):** FACT. A three-message handshake — client sends `initialize` with `protocolVersion`, `capabilities` (ClientCapabilities), `clientInfo`; server replies with its chosen `protocolVersion`, `capabilities` (ServerCapabilities), `serverInfo`, optional `instructions`; client sends `notifications/initialized`. Negotiated state was then assumed for the session's lifetime.

**The new model (2026-07-28):** FACT (basic/index.mdx, versioning.mdx):

- "There is no negotiation handshake. Every request carries its protocol version, and the server accepts or rejects each request independently."
- Every client request MUST carry in `_meta`:
  - `io.modelcontextprotocol/protocolVersion` (string, **required**), e.g. `"2026-07-28"`;
  - `io.modelcontextprotocol/clientCapabilities` (`ClientCapabilities`, **required**) — "capabilities relevant to this request";
  - `io.modelcontextprotocol/clientInfo` (`Implementation`, optional but SHOULD);
  - `io.modelcontextprotocol/logLevel` (optional; per-request log level, replacing `logging/setLevel`).
- Missing required fields → `-32602` Invalid params (HTTP 400). Unsupported version → `UnsupportedProtocolVersionError` (`-32022`) whose `data` lists `supported` versions and echoes `requested`; the client retries with a mutually supported version. Undeclared-but-needed client capability → `MissingRequiredClientCapabilityError` (`-32021`) with `data.requiredCapabilities`.
- Servers MUST implement **`server/discover`**: returns `resultType: "complete"`, `supportedVersions: [...]`, `capabilities: {...}` (ServerCapabilities), `instructions` (natural-language guidance for LLMs), `_meta["io.modelcontextprotocol/serverInfo"]`, plus caching hints `ttlMs`/`cacheScope`. Calling it is optional for clients — it exists for UX (present a server's surface in one call) and as the stdio era-detection probe.
- Servers SHOULD attach `io.modelcontextprotocol/serverInfo` to every result's `_meta`. Both `clientInfo` and `serverInfo` are explicitly "self-reported … not verified by the protocol … SHOULD NOT rely on them for security decisions."

**The capability objects** — SOURCE-CODE OBSERVATION (schema.ts, 2026-07-28):

```typescript
export interface ClientCapabilities {
  experimental?: { [key: string]: JSONObject };
  roots?: {};                       // @deprecated (SEP-2577)
  sampling?: {                      // @deprecated (SEP-2577)
    context?: JSONObject;           // includeContext support
    tools?: JSONObject;             // tool-use-in-sampling support (SEP-1577)
  };
  elicitation?: { form?: JSONObject; url?: JSONObject };
  extensions?: { [key: string]: JSONObject };  // extension id -> settings
}
export interface ServerCapabilities {
  experimental?: { [key: string]: JSONObject };
  logging?: JSONObject;             // @deprecated (SEP-2577)
  completions?: JSONObject;
  prompts?:   { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?:     { listChanged?: boolean };
  extensions?: { [key: string]: JSONObject };
}
```

The JSDoc states explicitly: "Known capabilities are defined here … but this is not a closed set: any server can define its own, additional capabilities."

- FACT. The capability grammar therefore has **three tiers**: (1) *named core capabilities* (typed sub-objects, presence = support, nested booleans/objects for sub-features like `listChanged`); (2) *`experimental`* — a free-form namespace for non-standard capabilities; (3) *`extensions`* — a governed namespace where keys are reverse-DNS extension identifiers (`io.modelcontextprotocol/tasks`, `com.example/my-extension`) and values are per-extension settings objects ("an empty object indicates support with no settings").
- FACT (versioning.mdx). Extension negotiation rule: "If one party supports an extension but the other does not, the supporting party MUST either revert to core protocol behavior or reject the request with an appropriate error. Extensions SHOULD document their expected fallback behavior."
- FACT. Enforcement is bidirectional: "A server MUST NOT rely on capabilities the client has not declared" (with `-32021` as the typed failure), and (MRTR) "Servers MUST NOT send an `inputRequests` that the client has not declared support for in its capabilities."
- INFERENCE (HIGH). This is the most complete capability-contract design in the ecosystem: *declared, typed, negotiated per-request, namespaced for evolution, with typed errors for both version mismatch and capability mismatch*. Note what capabilities are **not**: they are not permissions (no authority attenuation), not resource grants, not budgets — they are *feature-support declarations*. Authority in MCP lives entirely in OAuth scopes and host policy.

### 4. `_meta` — the protocol's extension bus

- FACT (basic/index.mdx). `_meta` is a general metadata carrier on every request/result/notification. Key grammar: optional reverse-DNS prefix + `/` + name; any prefix whose second label is `modelcontextprotocol` or `mcp` is reserved. Reserved keys: `progressToken`, the four `io.modelcontextprotocol/*` per-request fields, `io.modelcontextprotocol/subscriptionId`, and — as a special compatibility carve-out — bare `traceparent`, `tracestate`, `baggage` for **W3C/OpenTelemetry trace context propagation** (SEP-414), aligned with OTel GenAI semantic conventions for MCP.
- INFERENCE (HIGH). `_meta` evolved from an escape hatch into the protocol's *control plane*: version, identity, capabilities, log level, tracing, and subscription correlation all ride in `_meta` rather than in method-specific params. For a kernel design, this validates the pattern of a uniform, namespaced envelope-metadata field that lets orthogonal concerns (observability, versioning, extensions) evolve without touching operation schemas.

### 5. Server primitives: tools, resources, prompts

- FACT (server/tools.mdx). A `Tool` = `name` (SHOULD be 1–128 chars of `[A-Za-z0-9_.-]`, unique per server; SEP-986), `title`, `description`, `icons`, `inputSchema` (JSON Schema, default dialect 2020-12, MUST be a valid object), optional `outputSchema`, optional `annotations`. Tool results carry `content` (text/image/audio blocks, `resource_link`s, embedded resources) and/or `structuredContent` (JSON conforming to `outputSchema`). Tool *execution* errors are in-band (`isError: true` result) so the model can self-correct; input-validation errors are also tool-execution errors, not protocol errors (SEP-1303).
- SOURCE-CODE OBSERVATION. `ToolAnnotations` = `title`, `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` (default true). Spec warning: "clients MUST consider tool annotations to be untrusted unless they come from trusted servers."
- FACT. New in 2026-07-28: **`x-mcp-header`** — a JSON-Schema extension property inside `inputSchema` that designates primitive-typed, statically-reachable parameters to be mirrored into `Mcp-Param-{name}` HTTP headers so that "network intermediaries (load balancers, proxies, WAFs) can route and process requests based on parameter values without parsing the request body." Clients MUST reject tools with malformed `x-mcp-header` (excluding just that tool from `tools/list`).
- FACT. Tool-name collisions across servers are explicitly the *aggregator's* problem: "Clients or proxies that aggregate tools from multiple servers MAY encounter naming collisions … SHOULD implement a disambiguation strategy such as prefixing." Server `name` is *not* guaranteed unique.
- FACT (server/resources.mdx, subscriptions.mdx). Resources = URI-addressed content with `mimeType`, annotations, and **URI templates** (RFC 6570) via `resources/templates/list`. Per-resource update subscriptions survive, but re-based on `subscriptions/listen` (below). Resource-not-found is now `-32602` (was `-32002`; SEP-2164/SEP-2106 relaxed schema validation and defined `$ref` handling — network `$ref`s MUST NOT be auto-dereferenced by default; validators SHOULD bound composition-keyword cost as a DoS defense).
- FACT (server/prompts.mdx). Prompts = named, parameterized message templates (`prompts/list`, `prompts/get`), user-controlled by design (slash-command style), with argument autocompletion via the separate `completions` capability.
- FACT (server/utilities/pagination.mdx + caching.mdx). All list operations use opaque `cursor`/`nextCursor` pagination. New in 2026-07-28: `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read` results MUST carry **`ttlMs`** (freshness hint, ≥0, semantics ≈ `Cache-Control: max-age`) and **`cacheScope`** (`"public"` — shareable across users/gateways; `"private"` — MUST NOT cross authorization contexts). Notifications act as immediate invalidation on top of TTL. Servers MUST return deterministic tool ordering for cacheability.

### 6. Client features: sampling, elicitation, roots — and the great deprecation

- FACT. **Sampling** (`sampling/createMessage`) is MCP's inversion of control: a server asks the client/host to run an LLM completion, with `modelPreferences` (hints + `intelligencePriority`/`speedPriority`/`costPriority` weights), `systemPrompt`, `maxTokens`; since 2025-11-25 also `tools` + `toolChoice` (SEP-1577), where tool definitions are *scoped to the sampling request* — enabling a server-driven agentic loop executed on the client's model, with human-in-the-loop approval expected at the host.
- FACT. **Elicitation** (`elicitation/create`) asks the user for input mid-operation. Two modes: **form** (flat JSON-schema-validated fields; responses `accept`/`decline`/`cancel`) and **URL** (added 2025-11-25, SEP-1036: direct the user to an out-of-band URL "for sensitive interactions that must *not* pass through the MCP client" — credentials, OAuth-style flows). Servers MUST NOT collect secrets via form mode. Capability is `elicitation: { form?: {}, url?: {} }`; an empty object means form-only (backwards compat).
- FACT. **Roots** (`roots/list`) let a client advertise filesystem/URI scopes the server should operate within — always informational, never enforced.
- FACT (SEP-2577, Final; deprecated.mdx). **Roots, Sampling, and Logging were all deprecated in 2026-07-28**, with earliest removal in the first revision on/after 2027-07-28. Stated rationale from the SEP: roots — "low adoption … vague semantics … overlapping alternatives"; sampling — "complex to implement … low adoption … direct alternatives" (servers can just call provider APIs); logging — stderr + OpenTelemetry cover it. Elicitation *survives* as the only non-deprecated client feature.
- INFERENCE (HIGH). The deprecation of sampling is the ecosystem's verdict on protocol-mediated model access: the "server borrows the client's model" inversion was architecturally elegant but lost to the practical alternative of servers calling model APIs directly. For our kernel: a *model-invocation capability* offered by the runtime to plugins must be dramatically cheaper to adopt than direct API integration, or it will suffer sampling's fate. The survival of elicitation shows the durable inversion is *user interaction*, not model access — only the host owns the user.

### 7. MRTR — Multi Round-Trip Requests (the new inversion-of-control mechanism)

- FACT (patterns/mrtr.mdx). Server-initiated JSON-RPC requests are gone ("no longer supported. This is a breaking change"). Instead, when a server needs client input (elicitation, sampling, roots) mid-request, it *returns* a result with `resultType: "input_required"` — an `InputRequiredResult` containing:
  - `inputRequests`: a map of server-assigned keys → embedded request objects (`ElicitRequest` | `CreateMessageRequest` | `ListRootsRequest`);
  - `requestState`: an opaque server-minted string. Clients MUST echo it back verbatim and MUST NOT inspect it.
  The client gathers answers, then **retries the original request** (new JSON-RPC id) with `inputResponses` (same keys) plus the echoed `requestState`. Only `tools/call`, `resources/read`, `prompts/get` may return `input_required`.
- FACT. `requestState` is normatively treated as attacker-controlled: servers MUST integrity-protect it (HMAC/AEAD) if it influences authorization or logic, SHOULD bind it to principal + TTL + originating-request digest, and MUST enforce single-use server-side where required. The example literally shows `"requestState": "AEAD-protected blob"`.
- FACT. All results now carry `resultType` (`"complete"` | `"input_required"`; extensions may add values — tasks adds `"task"`); absent `resultType` from older servers is read as `"complete"`.
- INFERENCE (HIGH). MRTR is a *continuation-passing* design: the server externalizes its continuation into an encrypted token carried by the client, making the interaction resumable on any replica with zero shared storage. This is the same trick as stateless web session tokens, applied to agent-protocol control flow. For a kernel: interactive pauses (approvals, input, checkpoints) can be modeled as *typed suspensions with sealed continuation state* rather than as live bidirectional channels — a far better fit for durable execution than callbacks.

### 8. Subscriptions, progress, cancellation

- FACT (patterns/subscriptions.mdx). `subscriptions/listen` is a single long-lived request whose *response* is an open notification stream. The client passes a `notifications` filter (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged` booleans; `resourceSubscriptions: [uri...]`); the server MUST NOT send unrequested types; the first message MUST be `notifications/subscriptions/acknowledged` echoing the honored subset. Every notification carries `io.modelcontextprotocol/subscriptionId` (= the listen request's JSON-RPC id) in `_meta` for demultiplexing. Graceful server-side closure = responding to the original request with an empty `complete` result. Subscriptions do not survive reconnect; clients re-subscribe.
- FACT (patterns/progress.mdx, cancellation.mdx; streamable-http.mdx). Progress: request opts in via `_meta.progressToken`; server emits `notifications/progress` (progress/total/message) *on that request's response stream only*. Cancellation on HTTP: **closing the request's SSE stream is the cancellation signal** (no message); on stdio: `notifications/cancelled`. Request-scoped notifications never travel on the listen stream.
- FACT. **Resumability was removed**: "Resumable SSE streams via `Last-Event-ID` are not supported" (2026-07-28). Prior revisions (2025-03-26 → 2025-11-25) had event-ID-based stream resumption with redelivery; SEP-2575 deleted it. Broken streams require complete re-issuance; durability moved wholesale into the Tasks extension.
- INFERENCE (MEDIUM). The deletion of transport-level resumability in favor of application-level task handles is a deliberate layering decision: durability belongs to *handles over state*, not to *replayable byte streams*. Our kernel should note this: event-sourced redelivery at the transport layer was tried by MCP and retired within ~16 months.

### 9. Tasks — durable execution as an extension

- FACT (extensions/tasks/overview.mdx; SEP-1686 → SEP-2663). Tasks entered as *experimental core* in 2025-11-25 (SEP-1686) and moved to official extension **`io.modelcontextprotocol/tasks`** in 2026-07-28 (SEP-2663). Negotiation: client puts the extension id in per-request `clientCapabilities.extensions`; server advertises it in `server/discover` capabilities. The **server decides per-request** whether to go async: it returns `CreateTaskResult` (`resultType: "task"`) with `taskId`, initial status, `ttlMs`, `pollIntervalMs` — and "the task is durably created before the response is sent."
- FACT. Lifecycle statuses: `working`, `input_required`, `completed`, `failed`, `cancelled` (last three terminal). Client polls `tasks/get` (SEP-2663 replaced the earlier blocking `tasks/result`; `tasks/list` was removed); on `input_required` the task surfaces an `inputRequests` map (MRTR re-used inside tasks) answered via `tasks/update`; `tasks/cancel` is cooperative ("the server acknowledges the intent but is not obligated to stop"). On `completed`, `result` holds exactly what the synchronous call would have returned; on `failed`, `error` holds the JSON-RPC error. Optional push: `notifications/tasks` via `subscriptions/listen`, each carrying full task state. Clients are told to persist task IDs across restarts.
- FACT (roadmap blog). 2026 roadmap work on tasks: "retry semantics when a task fails transiently, and expiry policies for how long results are retained."
- INFERENCE (HIGH). MCP's durable-execution answer is *server-owned durable handles + client polling + sealed input requests* — no workflow graph, no checkpoints of client state, no exactly-once semantics, no budget/lease model. It deliberately stops at the RPC boundary. The kernel gap: task *composition* (fan-out, dependencies, compensation) and *cost/budget accounting* are entirely absent and left to hosts.

### 10. Transports

- FACT (transports/*.mdx). Two core transports. **stdio**: newline-delimited JSON-RPC over stdin/stdout; logging to stderr; the spec now warns that a stdio process is *not* a session — "clients may interleave unrelated requests on the same transport." **Streamable HTTP**: one MCP endpoint accepting POST; every JSON-RPC message is its own POST; response is either `application/json` or a request-scoped SSE stream (notifications then final response). The GET notification endpoint and `Mcp-Session-Id` header are gone (SEP-2567). The 2024-11-05 **HTTP+SSE** transport is formally Deprecated (registry row since 2025-03-26; removal three months after SEP-2596 reached Final).
- FACT. **Header-based routing** (SEP-2243): every POST MUST carry `MCP-Protocol-Version` (matching `_meta`, else `HeaderMismatch` `-32020`/HTTP 400), `Mcp-Method` (= body `method`), and `Mcp-Name` (= `params.name`/`params.uri` for `tools/call`, `resources/read`, `prompts/get`; base64 sentinel encoding for non-ASCII), plus optional `Mcp-Param-{name}` from `x-mcp-header`. Purpose: gateways, rate limiters and WAFs can route on headers "without parsing JSON bodies."
- FACT. Security floor: Origin validation (403 on invalid — DNS-rebinding defense), localhost binding for local servers, auth on all connections. `X-Accel-Buffering: no` recommended on SSE; keep-alive via SSE comment lines.
- FACT. Era detection for backward compatibility is transport-specific and precisely specified (compatibility matrix in versioning.mdx): on stdio, probe with `server/discover` — a `DiscoverResult` or a recognized modern error means modern; anything else/timeout → fall back to `initialize`. On HTTP, attempt a modern request and inspect the 400 body. Era is cached per server process/origin.
- INFERENCE (MEDIUM). The `Mcp-Method`/`Mcp-Name`/`x-mcp-header` machinery shows MCP optimizing for a *middleboxed* deployment world (enterprise gateways). A kernel protocol should assume from day one that intermediaries need routable, policy-relevant metadata outside the payload.

### 11. Authorization

- FACT (authorization/index.mdx). MCP servers are **OAuth 2.1 resource servers** (draft-ietf-oauth-v2-1-13); clients are OAuth 2.1 clients; the authorization server is out of scope ("may be hosted with the resource server or a separate entity"). Servers MUST implement **RFC 9728 Protected Resource Metadata**; clients MUST use it for AS discovery; AS discovery via RFC 8414 and/or OIDC Discovery (clients MUST support both). Clients MUST send **RFC 8707 `resource`** indicators on both authorization and token requests; servers MUST validate audience binding and "MUST NOT accept or transit any other tokens" (explicit anti-token-passthrough rule).
- FACT. Client registration priority (client-registration.mdx): **Client ID Metadata Documents** (CIMD, draft-ietf-oauth-client-id-metadata-document — the client_id *is* an HTTPS URL serving its own metadata) SHOULD be supported; pre-registration; **Dynamic Client Registration (RFC 7591) is Deprecated** as of 2026-07-28 (PR #2858), retained only for legacy ASes. New hardening in 2026-07-28: RFC 9207 `iss` validation with a normative four-row validation table (SEP-2468); `application_type` during registration (SEP-837); credential binding — clients key credentials by issuer, never reuse across servers (SEP-2352, anti-confused-deputy).
- FACT. Scope model: 401 challenges SHOULD carry `scope` guidance; runtime `insufficient_scope` → 403 + `WWW-Authenticate` challenge; clients run a **step-up authorization flow** computing the union of prior + challenged scopes (SEP-835 incremental consent). stdio transport pointedly does *not* use OAuth: "retrieve credentials from the environment."
- FACT (extensions/auth). Additional auth ships as extensions in `modelcontextprotocol/ext-auth`: **OAuth Client Credentials** (machine-to-machine) and **Enterprise Managed Authorization** (EMA — centralized enterprise IdP policy control, from SEP-990 lineage).
- INFERENCE (HIGH). MCP's authz story is *authority-by-token, discovery-by-metadata*, cleanly separated from capability declaration. The step-up scope flow is the closest thing the ecosystem has to dynamic privilege escalation UX, and CIMD (identity = dereferenceable URL you control) is a genuinely reusable pattern for plugin identity in a runtime registry.

### 12. Versioning, feature lifecycle, and evolution machinery

- FACT. Versions are **date strings** (`YYYY-MM-DD`), revised only on breaking changes; the doc set keeps every revision plus `draft`. Negotiation is per-request (section 3). Backwards compatibility across the 2026 pivot is handled by the explicitly-specified **era model** (modern / legacy / dual-era) with a full 7-row compatibility matrix — dual-era servers may serve both eras concurrently on one endpoint, selecting semantics by how the client opens (`_meta` vs `initialize`).
- FACT (community/feature-lifecycle.mdx, SEP-2596). Formal **feature lifecycle**: every core feature is Active / Deprecated / Removed. Deprecation requires a SEP documenting rationale + migration path + a **minimum twelve-month deprecation window** measured from the revision release; removal is a Core Maintainer decision at release time; `deprecated.mdx` is the canonical registry ("the canonical answer to 'what is on its way out, and by when'"). Tier 1 SDKs MUST mark deprecated surface with native mechanisms and SHOULD emit runtime warnings — persistent failure triggers SDK tier relegation.
- FACT. Evolution channels, in increasing formality: `experimental` capability bag → `experimental-ext-*` repos (working-group incubation) → Extensions Track SEP → official `ext-*` repo → (possibly) core. Extensions "are always disabled by default and require explicit opt-in"; they evolve independently of core; breaking changes should mint a new identifier (`…/my-extension-v2`).
- INFERENCE (HIGH). MCP now has a complete *evolution-without-redesign* toolkit: date-versioned core + per-request negotiation + namespaced `_meta` + three-tier capability declaration + governed extension identifiers + a deprecation clock. The 2026-07-28 release proves the machinery works under stress: the protocol replaced its own lifecycle model *using* its versioning model, and shipped the compatibility path in the same revision.

### 13. Extensions framework in detail

- FACT (extensions/overview.mdx, SEP-2133). Extension identifier = `{vendor-prefix}/{extension-name}` following `_meta` key rules; official prefix `io.modelcontextprotocol`; third parties use owned reverse-DNS. Official extensions live in `ext-*` repos (currently: `ext-auth` — client credentials, EMA; `ext-apps` — MCP Apps; `ext-tasks` — Tasks). Lifecycle: Extensions Track SEP → reference implementation in an official SDK (required before review) → Core Maintainer approval → publication. SDKs choose freely which extensions to support. Negotiation is symmetric via the `extensions` capability field on both sides.
- INFERENCE (HIGH). The extension mechanism is precisely the "capabilities as plugins" pattern our mission hypothesizes: *tasks* (durable execution) and *apps* (UI) — things most protocols would hard-code — are opt-in negotiated modules with their own repos, versioning, and graduation path. Core stays minimal by policy ("we are **not** adding more official transports this cycle" — roadmap).

### 14. MCP Apps / UI extension

- FACT (extensions/apps, SEP-1865, Final, Extensions Track; authors include mcp-ui's Ido Salomon and Liad Yosef plus OpenAI and Anthropic engineers). MCP Apps (`io.modelcontextprotocol/ui`): tools declare `_meta.ui.resourceUri` pointing at a **`ui://` resource** (`text/html;profile=mcp-app`); host preloads/fetches it, renders in a **sandboxed iframe**; app↔host communication is "a JSON-RPC protocol that forms its own dialect of MCP" (shared `tools/call`, `ui/initialize`, `ui/*` methods) over postMessage. Resource `_meta.ui` can declare `permissions` (mic/camera etc.) and `csp` (allowed external origins). Client capability advertises supported `mimeTypes`. Host mediates everything: the app "can delegate actions to the host, which can then invoke the capabilities and tools the user has already connected (subject to user consent)."
- OBSERVED BEHAVIOR (HIGH). The lineage is community mcp-ui → SEP-1865 co-design (announced on the MCP blog 2025-11, with OpenAI's Apps SDK building on the same MCP foundation) → official `ext-apps`. The Apps extension is the standardized successor to both.
- INFERENCE (MEDIUM). Apps establishes a *capability-scoped sandboxed artifact* pattern: UI is just a resource type plus a negotiated capability plus a host-mediated RPC bridge. A kernel can treat "renderable artifact with a mediated backchannel" as one more capability rather than a UI subsystem.

### 15. Registry

- FACT (docs/registry/about.mdx). The **official MCP Registry** (still "in preview") is a centralized *metadata* repository for public servers: `server.json` (name, package/remote location, execution instructions, env vars, capabilities description), reverse-DNS namespacing with **DNS/GitHub-verified ownership** (`io.github.user/server`, `com.example/server`), a REST API + OpenAPI spec that sub-registries/aggregators implement, explicit non-goals (no private servers, not designed for self-hosting, host apps should consume downstream aggregators, security scanning delegated to package registries and aggregators).
- INFERENCE (MEDIUM). Discovery is deliberately split: *what exists* (registry, static metadata, verified namespace) vs *what a live endpoint supports* (`server/discover`, dynamic). A kernel registry should preserve this static/dynamic split rather than conflating catalog metadata with runtime negotiation.

### 16. Governance

- FACT (GOVERNANCE.md, sep-guidelines.mdx). MCP is **"Model Context Protocol a Series of LF Projects, LLC"** (Linux Foundation) — spec/code under Apache-2.0, docs CC-BY-4.0. Change process: **SEPs** as PRs; types include Standards Track, Informational, Process, **Extensions Track**; statuses proposal → draft (requires a Core-Maintainer/WG sponsor) → in-review → accepted → final (also rejected/withdrawn/superseded/dormant). Since SEP-2484: Standards-Track SEPs with observable behavior require a **conformance scenario merged into `modelcontextprotocol/conformance`** plus a traceability file (`sep-NNNN.yaml`) mapping every MUST/SHOULD to a check ID before reaching Final. Final SEPs are frozen historical records; the spec is authoritative. Working Groups/Interest Groups (SEP-1302) with charters and a contributor ladder (SEP-2148); SDK tiering with maintenance commitments and relegation (SEP-1730). Tier 1 SDKs at 2026-07-28: TypeScript, Python, Go, C# (Rust beta).
- INFERENCE (MEDIUM). The conformance-test-per-SEP requirement is the strongest evolution-governance mechanism observed anywhere in this research program: normative language is mechanically traced to executable checks *as a precondition of finalization*.

### 17. What MCP deliberately does NOT cover — the gap map

All FACT-by-absence (verified against the full 2026-07-28 doc tree) with INFERENCE framing:

- **Agent lifecycle & delegation**: no concept of spawning, supervising, or delegating to agents. The roadmap explicitly frames MCP as "enabling agent workflows rather than as an agent orchestration protocol." Agent-to-agent delegation is left to other protocols (A2A et al.) and to hosts.
- **Budgets / cost / metering**: no token, currency, or rate budget anywhere in the schema. `maxTokens` on (deprecated) sampling is the sole cost-adjacent field.
- **Planning / workflow graphs**: no graph, DAG, or step construct. Tasks are single opaque operations.
- **Checkpoints of conversational state**: the host owns all conversation state; the protocol never represents it. `requestState` and `taskId` are the only durable protocol-level state, both server-minted and opaque.
- **Model management**: no model identity, routing, or invocation surface (post-sampling-deprecation, none at all).
- **Memory**: ABSENT entirely; resources are the nearest primitive.
- **Policy language**: consent and authorization *requirements* are stated ("hosts enforce security policies and consent"), but no policy representation exists on the wire beyond OAuth scopes and tool annotations (which are explicitly untrusted hints).
- **Exactly-once / transactional semantics**: cancellation is cooperative; tasks have no retry contract yet (roadmap item); idempotency is an untrusted hint.

## Architecture decomposition

Mapping MCP onto the mission's layer stack. MCP is a *protocol*, so most layers are host-side and out of scope by design — that is itself the finding.

| Layer | MCP's coverage | Status |
| --- | --- | --- |
| Product/UI | Out of protocol scope, except **MCP Apps** extension (sandboxed `ui://` HTML artifacts + `ui/*` RPC dialect) and elicitation/icons rendering duties placed on hosts | Standardized (extension), portable |
| Agent/Harness | The **host** — creates clients, enforces consent, aggregates context. Named but entirely unspecified | ABSENT from wire protocol; host-proprietary |
| Planning/orchestration | ABSENT. No plans, graphs, or delegation | — |
| Context construction | Host-owned by principle #3 (servers can't see the conversation). Protocol contributes *inputs*: resources, prompts, `instructions` from `server/discover`, tool descriptions | Host-proprietary; inputs standardized |
| Model invocation | Deprecated **sampling** (server→client inversion, incl. tool loops via SEP-1577); being removed in favor of direct provider APIs | Standardized but dying; provider-specific replaces it |
| Tool selection/execution | Selection: host/model concern (fed by `tools/list` + annotations + icons). Execution: `tools/call` with JSON-Schema I/O contracts, in-band execution errors, MRTR suspensions, optional task handles | Standardized, portable — MCP's core value |
| Environment | Servers wrap environments (FS, DBs, APIs); stdio vs Streamable HTTP; registry `server.json` carries execution instructions | Standardized boundary; environment itself out of scope |
| Observation | Content blocks, `structuredContent` vs `outputSchema`, resource reads, progress notifications | Standardized |
| Verification | Schema validation duties (2020-12 default, bounded validation); conformance suite at the ecosystem level; no runtime result verification | Mostly ABSENT at runtime; standardized at governance level |
| State update | Stateless core + explicit handles: `requestState` (sealed continuations), `taskId` (durable ops), `subscriptionId`, cursors, TTL'd caches | Standardized; deliberately minimal |

Cross-cutting: **capability negotiation** (per-request declaration + `server/discover` + typed mismatch errors) and **authorization** (OAuth 2.1 RS + RFC 9728/8707/9207 + CIMD) are the two fully-standardized planes; **observability** is delegated to OpenTelemetry via reserved `_meta` keys.

## Precise vocabulary

For MCP, 2026-07-28:

- **Model**: ABSENT as a protocol concept. Only residue: `modelPreferences` hints and the `model` string in (deprecated) sampling results.
- **Model API / model adapter**: ABSENT. Post-SEP-2577, model access is explicitly pushed to provider APIs outside the protocol.
- **Agent**: ABSENT. The nearest entity is the **host** (policy container) — never called an agent by the spec.
- **Agent loop**: ABSENT from the wire. The only loop shapes the protocol expresses are the MRTR retry loop and the (deprecated) sampling-with-tools loop.
- **Harness**: the **host process** — "creates and manages multiple client instances… enforces security policies and consent requirements… coordinates AI/LLM integration." Named, unspecified, proprietary.
- **Context-management system**: ABSENT (host-owned by design principle: servers must not read the conversation).
- **Memory system**: ABSENT.
- **Tool runtime**: the **MCP server** — the unit that executes `tools/call` against declared `inputSchema`/`outputSchema`, with annotations as untrusted behavior hints.
- **Execution environment**: whatever a server wraps; the protocol sees only the server boundary plus registry execution metadata (`server.json` command/args/env).
- **Planner / workflow / graph construct**: ABSENT.
- **State/session model**: *statelessness as doctrine* — "no state should be inferred from previous requests, even those on the same connection"; all cross-request state via explicit identifiers: `requestState` (opaque, integrity-protected continuation), `taskId` (durable operation handle), `subscriptionId`, pagination cursors. Protocol-level sessions (`Mcp-Session-Id`) existed 2025-03-26 → 2025-11-25 and were removed.
- **Delegation mechanism**: ABSENT (no server→server or agent→agent calls; hosts may aggregate/proxy but that is out of spec).
- **Protocol usage**: JSON-RPC 2.0 over stdio or Streamable HTTP; polymorphic results via `resultType`; MRTR for inversion; `subscriptions/listen` for push.
- **Capability discovery/negotiation**: the crown jewel — per-request `_meta` capability declaration (required), `server/discover` (mandatory server-side), typed capability objects with `experimental` and `extensions` namespaces, `UnsupportedProtocolVersionError`/`MissingRequiredClientCapabilityError` as negotiation-by-error, extension settings objects, 12-month deprecation clocks.
- **Policy/security layer**: OAuth 2.1 resource-server model + RFC 9728/8707/9207 + CIMD; host consent duties (normative but unwired); Origin validation; sealed `requestState`; sandboxed Apps with `permissions`/`csp`. No policy *language*.
- **Durable-execution features**: Tasks extension only (durable handles, polling, cooperative cancel, MRTR-in-tasks); transport resumability deliberately removed.
- **Event system**: opt-in filtered notification streams (`subscriptions/listen`) + request-scoped progress/log notifications. No event log, no replay (removed), no event IDs.
- **Observability**: OpenTelemetry trace-context propagation via reserved `_meta` keys (`traceparent`/`tracestate`/`baggage`, SEP-414) aligned with OTel GenAI MCP semconv; per-request `logLevel`; otherwise delegated (logging feature deprecated in favor of stderr/OTel).

## Implications for a universal runtime kernel

1. **Adopt the three-tier capability grammar.** MCP's `{named typed capabilities} + {experimental: free-form} + {extensions: governed reverse-DNS ids → settings objects}` is a proven contract shape that survived a full architectural rewrite. A kernel capability contract should copy the tiering, the identifier grammar, the "empty object = supported, no settings" convention, and the mandatory documented-fallback rule.
2. **Negotiation-by-typed-error beats handshake.** The 2026 pivot shows a handshake is unnecessary: self-describing requests + `UnsupportedProtocolVersion`/`MissingRequiredCapability` errors + an optional cached `discover` endpoint give the same guarantees statelessly, and make every request independently routable/auditable. Kernel envelopes should carry version+capabilities; discovery should be an optimization, not a dependency.
3. **Model suspensions as sealed continuations, not callbacks.** MRTR's `input_required` + AEAD-protected `requestState` turns "the plugin needs something from the runtime/user" into a resumable, replica-independent data structure. This is the right substrate for approvals, HITL, and checkpointing in a durable kernel — and it composes with async (tasks reuse the same `inputRequests` shape).
4. **Durability = handles, not replayable streams.** MCP added event-ID stream resumption (2025-03-26) and deleted it (2026-07-28), keeping durable task handles instead. A kernel should make artifacts/tasks the durable layer and treat transports as disposable.
5. **Date-versioned core + independent extension evolution + deprecation clocks = evolution without redesign.** The full machinery (per-request version, era model with compatibility matrix, Active/Deprecated/Removed with a 12-month floor, extension graduation ladder, conformance-test-gated SEPs) is directly liftable as the kernel's compatibility policy.
6. **Learn from sampling's death.** Protocol-mediated model access lost to direct API calls because it was complex for hosts and slow to adopt. A kernel "model capability" must be near-zero-friction (or the kernel should *be* the model caller and expose invocation as a budgeted service, which MCP structurally could not do because it has no budget concept).
7. **Elicitation survived; the host's monopoly is the user, not the model.** The durable inversion-of-control primitive is user interaction. A kernel should reserve a first-class, policy-gated "ask the principal" capability (with MCP's form/URL split for secret-safety).
8. **Capabilities ≠ authority.** MCP cleanly separates feature declaration (capabilities) from authority (OAuth scopes + step-up flow + audience-bound tokens). A kernel capability model that wants *attenuable authority* must add it — MCP proves you can defer it to OAuth, and also shows the cost: no protocol-level budgets, leases, or fine-grained grants.
9. **Design for middleboxes.** `Mcp-Method`/`Mcp-Name`/`x-mcp-header`/`cacheScope` exist so gateways can route, rate-limit, and cache without parsing payloads. Kernel envelopes need a deliberate "intermediary-visible" projection.
10. **The gap map is our product surface.** Everything MCP refuses to standardize — agent lifecycle, delegation, planning/graphs, budgets, conversational checkpoints, memory, policy language, retry/exactly-once semantics — is precisely the layer a universal runtime kernel would own, sitting *above* MCP and speaking it southbound to capability providers.

## Open questions

1. The Tasks extension's pending retry semantics and result-expiry policies (2026 roadmap): will they introduce the first protocol-level reliability contract (at-least-once? lease-based?), and should our kernel wait for or preempt that design?
2. How do dual-era servers behave in practice at scale — is the era model (modern/legacy concurrent on one endpoint) holding up in Tier 1 SDK implementations, or producing subtle capability drift?
3. `server/discover` currently returns capabilities without authentication context in the `public` cache scope; how do servers whose tool lists are authorization-dependent reconcile discovery caching with per-principal filtering?
4. MCP Apps' `ui/*` dialect is "its own dialect of MCP" — is it converging with or diverging from OpenAI's Apps SDK surface, and does the host-mediated `permissions`/`csp` model suffice for a kernel treating UI as a generic sandboxed-artifact capability?
5. Is anything using `ClientCapabilities.experimental` in the wild anymore, or has the governed `extensions` field fully displaced it (making a two-tier grammar sufficient for our kernel)?
6. The stateless pivot pushes all continuation state into server-minted `requestState`/`taskId` blobs; what are the observed size/latency limits of AEAD continuation tokens in production, and do they constrain how much suspended state a kernel can externalize this way?
