# Backend architecture

Authoritative spec for the backend: runtime, auth, data model, security, performance, and every external connection. Pairs with `agent_os_convex_notion_architecture.md` (product-level workflow overview) and `intelligence_layer_architecture.md` (AI/agent internals) — all three describe one system built on Convex. Nothing here overrides the workflow shapes or agent count already established; this doc adds the depth those left out.

## 0. One-paragraph mental model

Convex is the entire backend — database, serverless functions, durable workflows, real-time subscriptions, file storage, vector search, and scheduled jobs, all in one deployment. There is no separate API server, no separate database to connect to, no message queue to run. Four external systems are called from inside Convex: OpenRouter (LLM), GitHub (execution), Notion (reporting), Teams (notification). Everything else — every rule, every threshold, every access check — is deterministic TypeScript running inside Convex functions.

---

## 1. Runtime split — this is the first security and performance decision

Convex functions run in one of two runtimes, and which one each function uses is a deliberate choice, not a default:

| Runtime | Used for | Why |
|---|---|---|
| **V8 isolate** (default) | All queries, all mutations, all read paths (dashboards, live trace, audit log) | Near-zero cold start, sandboxed (no arbitrary network access by default) — this is the runtime users are staring at, so it must always be fast |
| **Node.js action** (`"use node"`) | Every function that calls OpenRouter, GitHub, Notion, or Teams; every LangGraph.js graph execution | Needs the npm ecosystem and outbound HTTP; slower cold start is acceptable here because it's always on the "agent is working" path, never the path a human is watching render |

**Security implication:** because only Node actions can reach the network, every place a secret could leak or an external call could misfire is confined to a small, auditable set of files. A bug in a query or mutation cannot, by construction, call OpenRouter or GitHub — the V8 runtime has no path to do it.

---

## 2. Authentication & authorization

Not fully specified in the earlier product doc — this is the gap this doc closes.

- **Identity:** Convex Auth (or an OIDC provider wired into Convex — WorkOS/Clerk are both drop-in) issues sessions for every user. No custom session handling to build.
- **`users` table:**
```ts
users: {
  email: string,
  role: "requester" | "approver" | "admin",
  department: string,
}
```
- **Every mutation and query that touches business data starts with an identity + role check:**
```ts
const identity = await ctx.auth.getUserIdentity();
if (!identity) throw new Error("Not authenticated");
const user = await getUserByEmail(ctx, identity.email);
if (user.role !== "approver" && user.role !== "admin") throw new Error("Not authorized");
```
This check lives in the function itself, server-side — never inferred from what button the frontend happened to render. A requester hitting the approve mutation directly (bypassing the UI) gets rejected by the function, not just hidden by a missing button.
- **Role boundaries, concretely:**
  - `requester`: can create requests, read only their own requests' status and trace.
  - `approver`: can read all pending items in their agent's queue, can call approve/reject/edit mutations.
  - `admin`: everything an approver can do, plus edits to policy tables (§4) and secrets rotation.
- **Least privilege applies to service credentials too** — see §5.

---

## 3. Data model

Same core schema as the product doc, reprinted here with indexes and access notes — this is the version to actually build from.

```ts
users: {
  email: string, role: "requester" | "approver" | "admin", department: string,
}
  .index("by_email", ["email"])

requests: {
  type: "expense_batch" | "hire_provisioning" | "vendor_procurement",
  requesterEmail: string,
  status: "processing" | "auto_cleared" | "pending_approval" | "approved" | "rejected" | "auto_rejected",
  createdAt: number,
}
  .index("by_status", ["status"])
  .index("by_type_status", ["type", "status"])   // powers each agent's approver queue view
  .index("by_requester", ["requesterEmail"])      // powers the requester's "my requests" view

expense_items: {
  requestId: Id<"requests">, vendor: string, amount: number, category: string,
  date: string, poNumber: string | null, employee: string,
  anomalyFlags: string[], status: "auto_cleared" | "flagged" | "approved" | "rejected",
  reasoning: string,
}
  .index("by_request", ["requestId"])
  .index("by_status", ["status"])

hire_provisioning_requests: {
  requestId: Id<"requests">, newHireEmail: string, githubUsername: string,
  proposedRepos: string[], reasoning: string, approverEdits: string | null,
  githubGrantStatus: "pending" | "granted" | "failed",
}
  .index("by_request", ["requestId"])

vendor_requests: {
  requestId: Id<"requests">, vendorName: string, brochureFileId: string,
  estimatedCost: number, department: string,
  complianceVerdict: "pass" | "violation" | "uncertain", complianceReasoning: string,
  budgetLeftover: number, budgetCovered: boolean, forwardedToApprover: boolean,
}
  .index("by_request", ["requestId"])

approvals: {
  requestId: Id<"requests">, approverEmail: string,
  decision: "approved" | "rejected" | "edited_and_approved",
  editsMade: string | null, decidedAt: number,
}
  .index("by_request", ["requestId"])

audit_log: {
  requestId: Id<"requests">, step: string, actor: string, detail: string, timestamp: number,
}
  .index("by_request", ["requestId", "timestamp"])   // live trace + full history, in order, one indexed read

company_rules: { text: string, embedding: vector, sourceDoc: string }
  // vector index for RAG — see intelligence_layer_architecture.md §8

notion_sync: { requestId: Id<"requests">, notionPageId: string, lastSyncedAt: number }
  .index("by_request", ["requestId"])   // upsert target, not insert-only — see §6
```

**Structural rule, not just convention:** no mutation in the codebase ever calls `.patch()` or `.delete()` on `audit_log`. It is insert-only by construction — there is simply no exposed function capable of altering a past entry. This is what makes the traceability requirement provably true, not just true by discipline.

**Files:** xlsx uploads and vendor brochures go through Convex file storage, referenced everywhere downstream by file ID. Same auth check as any other resource — a file ID alone doesn't grant read access, the function serving it still checks the caller's role/request ownership.

---

## 4. External integrations

Each of the four gets exactly one Node action module. Same pattern every time: validate input → call → retry-wrapped → log the fact of the call to `audit_log` (never the raw request/response if it could contain a secret).

**OpenRouter (LLM):** called only from within LangGraph.js graph nodes (see intelligence layer doc). Key stored as `OPENROUTER_API_KEY` env var, read server-side only, never sent to the client. Wrapped in `Action Retrier` (handles 429/5xx with backoff) and routed through `Workpool` (bounds concurrent in-flight calls — see §7).

**GitHub:** fine-grained PAT scoped to *only* the specific onboarding repos, not org-wide — if this token leaks, the blast radius is "collaborator access to a handful of repos," not "your GitHub org." Stored as `GITHUB_PAT` env var. The grant action re-checks that an `approvals` row with `decision: "approved"` exists for the request *inside the action itself* before calling the GitHub API — defense in depth, so a bug elsewhere that fires the action early still can't grant access without a real approval on record.

**Notion:** integration token as `NOTION_TOKEN` env var. Writes only — nothing is ever read back from Notion into a decision. `notion_sync` is keyed by `requestId` and upserted, so a retried report never creates a duplicate page.

**Teams:** webhook URL as `TEAMS_WEBHOOK_URL` env var. Notify-only, as decided — posts an Adaptive Card with a link back to the dashboard, never an interactive action. No secret flows from Teams back into the system.

---

## 5. Secrets & config

| Secret | Storage | Scope |
|---|---|---|
| `OPENROUTER_API_KEY` | Convex env var | Server-only, Node actions only |
| `GITHUB_PAT` | Convex env var | Fine-grained, scoped to onboarding repos only |
| `NOTION_TOKEN` | Convex env var | Scoped to the one workspace/parent page this system writes to |
| `TEAMS_WEBHOOK_URL` | Convex env var | Treated as a secret — anyone with the URL can post to the channel |

Rules: never appears in client bundle (Convex env vars are server-side by definition — there's no accidental leak path the way there is with `NEXT_PUBLIC_`-style prefixes). Never logged in full — `audit_log` records that a call happened and its outcome, never the credential or a request body that might carry it. Dev/staging/prod are separate Convex deployments with independently rotatable secrets, so a staging leak never touches production credentials.

---

## 6. Performance & scaling under load

- **No capacity planning.** Convex's query/mutation layer auto-scales; there's no server to size for peak load.
- **Every hot query is indexed** (§3) — dashboard filters, live trace reads, and approval queues are all O(log n) lookups, never table scans.
- **Reactive subscriptions replace polling entirely**, which is a real load reduction, not just nicer UX: N clients watching one request costs one query recomputation on change, not N repeated fetches.
- **Workpool bounds concurrency per external system independently.** A burst of expense uploads can't starve the GitHub queue or blow through OpenRouter's per-minute rate limit — each integration gets its own lane.
- **Rate Limiter component sits in front of the OpenRouter call specifically**, since free/low tiers cap at ~20 req/min. It queues excess calls rather than letting them fail, so a traffic spike degrades to "slightly slower" instead of "errors."
- **Pagination everywhere a list could grow unbounded** — audit log views, approval queues — never an unbounded `.collect()` on a table that grows with usage.
- **Convex Workflow turns retries/timeouts into configuration**, not bespoke code, which removes the most common way a slow external call cascades into a stuck request under load.

---

## 7. Reliability & error handling

- `Action Retrier` + exponential backoff wraps all four external calls.
- **Idempotency by design, not by luck:** the GitHub grant checks current collaborator state before granting, so a retried action is a safe no-op if the grant already happened. Notion sync is an upsert keyed by `requestId`. Neither operation can double-execute from a retry.
- **Crash recovery is automatic**, not something to build: Convex Workflow resumes an in-flight request from its last completed step if the process restarts mid-run.
- **Two strikes, then a human:** any LLM output that fails schema validation twice routes the request to the approval queue with a note that automated extraction failed, rather than guessing. This was true for Qwen and stays true for the OpenRouter model — bigger model, same fallback discipline.

---

## 8. Observability

- **Business-level trace:** `audit_log`, already the single source of truth for "what happened and why," read reactively by both portals and mirrored to Notion.
- **Technical-level:** Convex's built-in function dashboard (latency, error rate, invocation count per function) — no separate APM to stand up.
- **Cost visibility:** log token usage per LLM call (input/output tokens, model used) either as fields on the relevant `audit_log` row or a lightweight `llm_usage` table keyed by `requestId`. This matters specifically because OpenRouter is usage-billed — the free tier is not the reliability plan (§7 of the product doc), so real cost needs to stay visible even though each call is deliberately narrow and cheap.

---

## 9. Connections map

- **Frontend ↔ Backend:** Convex client SDK, reactive queries/mutations over a persistent WebSocket connection, session from Convex Auth. No REST layer to design or version.
- **Backend ↔ Database:** there is no hop — Convex's database is the same deployment as the functions. No connection pooling, no ORM, no separate DB credentials to manage. This is the concrete answer to "why Convex" from the product doc, at the infrastructure level.
- **Backend ↔ Intelligence layer:** Node actions invoke LangGraph.js graphs in-process, in the same deployment — not a separate microservice, not a network call. See `intelligence_layer_architecture.md`.
- **Backend ↔ External systems:** OpenRouter / GitHub / Notion / Teams, each through its own Node action module (§4), each behind Retrier + Workpool (§6–7).
- **Backend ↔ Frontend live trace:** every `audit_log` insert (written by a Workflow step or a LangGraph node completion) is picked up by the frontend's reactive subscription immediately — the same single mechanism powers the live trace, the approval queue, and the requester's status view. One write path, three read surfaces, zero risk of them disagreeing.

---

## 10. Build order (backend-specific, slots into the product doc's §8)

1. `users` table + Convex Auth + role checks on every function stub, before any business logic — get access control right while there's nothing to protect yet, not after.
2. Schema (§3) with indexes from day one — adding an index later is easy, but building queries that assume a scan is a habit worth not forming.
3. One external integration end-to-end (Notion is the simplest — no approval-gating, no idempotency risk) to prove the Node action + Retrier pattern before GitHub, where a mistake has real consequences.
4. GitHub action with the idempotency + defense-in-depth approval check (§4) before it ever touches a real repo.
5. Workpool + Rate Limiter in front of OpenRouter before load-testing anything — this is cheap to add early and painful to retrofit under real traffic.
