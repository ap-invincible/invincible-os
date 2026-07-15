# Intelligence layer architecture

Authoritative spec for everything AI-related: LLM routing, individual agent design, multi-agent handoff, orchestration, token/context management, and vector search. Pairs with `backend_architecture.md` (runtime, security, performance) and `agent_os_convex_notion_architecture.md` (product-level workflow overview) — same system, three angles.

## 0. The one rule this whole doc protects

**A bigger, smarter, hosted model does not mean the LLM's share of the decision grows.** Every technical choice below exists to make the LLM's narrow slice of the work more *reliable* — not to hand it more responsibility. If a design decision in this doc would let the model start deciding instead of labeling, that decision is wrong, regardless of how capable the underlying model is.

---

## 1. Where the intelligence layer runs

Every AI-related function is a Convex Node action (`"use node"`) — see `backend_architecture.md` §1. This isn't a separate service: LangGraph.js graphs execute in-process, in the same Convex deployment, invoked as steps of a Convex Workflow. No microservice to deploy, no second place for secrets to live, no network hop between "the backend" and "the AI part" — there is no seam.

---

## 2. LLM routing (OpenRouter)

- **Gateway:** `https://openrouter.ai/api/v1`, OpenAI-compatible — any OpenAI SDK works by pointing the base URL here with the OpenRouter key.
- **One model, configured centrally.** A single config module (not per-agent hardcoding) exports the active model string, e.g. `openai/gpt-4.1` (or the closest equivalent available at build time). Swapping models is a one-line change in one file — every agent picks it up automatically.
- **Honest note on "free":** OpenRouter's genuinely free models are rotating open-weight models with real limits (~20 req/min, low daily caps). GPT-4.1-class models are not on that free roster — they're pay-as-you-go, passthrough-priced. Given this system gates real approvals on unpredictable timing, the primary path runs on paid credits. This stays cheap in practice precisely because of the narrow-usage discipline in §6 — a handful of short, capped calls per request, not a chat session.
- **Fallback chain:** primary paid model → a secondary model (cheaper or free-tier) on error or rate-limit, using OpenRouter's model-array fallback in a single request rather than hand-rolled retry-with-different-model logic. Useful for resilience against a provider outage, not for cost-shaving — don't silently downgrade quality on a live approval-gating decision without that being a deliberate, logged choice.
- **No per-task model selection.** One model handles extract, classify, and explain across all three agents. Task-appropriate multi-model routing is real complexity that this system's actual LLM footprint (short, narrow, infrequent calls) doesn't earn — adding it now would itself be "borrowing too much intelligence," just architecturally instead of behaviorally.

---

## 3. Multi-agent architecture (recap)

Three agents, unchanged from the product doc: **Expense** (single-agent, no negotiation), **Hire** (HR validation → Engineering provisioning, structured handoff), **Vendor** (Finance-owned, RAG-gated). Agents exchange structured objects through the Convex Workflow, never free-form text — this is what makes "agents coordinate autonomously" a provable property instead of an emergent one.

---

## 4. Per-agent graph design (LangGraph.js)

**Why LangGraph specifically, and where:** the one place per agent with real multi-step, conditionally-branching logic (especially Vendor's retrieve → judge → gate sequence) benefits from typed state and explicit conditional edges instead of a hand-rolled if/else chain. `@langchain/langgraph` (npm, MIT-licensed, TypeScript-native) is a mature fit for a Convex Node action — no Python service, no separate runtime.

**State is typed and minimal — not a chat message list.** These aren't conversational agents, so there's no accumulating history to manage:
```ts
const VendorState = z.object({
  requestId: z.string(),
  vendorText: z.string(),
  retrievedRules: z.array(z.string()),
  complianceVerdict: z.enum(["pass", "violation", "uncertain"]),
  budgetCovered: z.boolean(),
  decision: z.enum(["forward", "auto_reject"]),
  reasoning: z.string(),
});
```

**Node types — and this is the key design move:** a node is not always an LLM call. The rules engine *is* a graph node, right alongside the LLM nodes:
- `extract` — LLM, narrow, schema-constrained output
- `retrieve` — Convex RAG vector search, no LLM
- `decide` / `check_budget` — pure deterministic function, no LLM, this is the rules engine
- `tool_call` — GitHub API, no LLM
- `explain` — LLM, drafts the one-sentence reasoning from facts the deterministic nodes already produced

Putting the rules engine inside the graph (instead of as a side-channel the graph calls out to) means the entire decision path — including the non-LLM parts — shows up in one place: the graph, and by extension the trace.

**Per-agent graphs, concretely:**
- **Expense:** `extract → decide → (auto_clear | flag) → explain`
- **Hire:** `extract → decide_access → propose` *(Workflow pause for human here)* `→ tool_call(grant) → explain`
- **Vendor:** `extract → retrieve_rules → judge_compliance → check_budget → gate → (forward | auto_reject) → explain`

**Every node completion writes one row to `audit_log`.** This is the same mechanism that powers the frontend's live trace — a node finishing *is* the event the trace renders, not a separate notification system built alongside it.

---

## 5. Orchestration layering — LangGraph vs. Convex Workflow, resolved explicitly

Two orchestration levels, two different jobs, deliberately no overlap:

| | Convex Workflow (macro) | LangGraph.js (micro) |
|---|---|---|
| Scope | The whole business process | One phase of one agent's work |
| Duration | Seconds to days (can wait on a human indefinitely) | Seconds — a handful of nodes |
| Durability | Must survive crashes/redeploys — this is its entire job | Doesn't need to — if a graph run fails mid-way, the Workflow step retries the whole graph from its input |
| Human pause | Yes — this is where it lives | No — a graph never waits on a human mid-execution |
| State of record | `audit_log` / Convex tables | Ephemeral within one action invocation |

**LangGraph's own persistence/checkpointing features are deliberately not used.** Using them would create a second place execution state lives, which is exactly the "two systems that could drift apart" problem this whole design has avoided from the start. Convex Workflow remains the only durable state; LangGraph is pure control-flow structure inside one of its steps.

In words: `Workflow.start() → [step: run the "propose" LangGraph graph] → write draft, pause for human → [human decides] → [step: run the "execute" LangGraph graph] → done`.

---

## 6. Token & context management

Context window is no longer the binding constraint — GPT-4.1-class models handle 128K+ tokens — but the discipline doesn't relax, because the constraint was never really about fitting, it was about not letting the model reason over things it doesn't need to:

- **One node, one job**, still. No accumulating chat history, no dumping the full policy file into a prompt just because there's room for it now.
- **RAG stays**, even with a bigger context window, because 3 relevant rules produce a more reliable compliance judgment than 3 relevant rules buried in 40 irrelevant ones — a bigger window doesn't make irrelevant context free, it just makes it possible to include by accident.
- **Explicit `max_tokens` ceiling per node type** — extract ≈200 output tokens, classify ≈50, explain ≈150. This caps latency and cost, and structurally prevents a node from "over-explaining" into territory that starts to look like it's making the decision rather than narrating one.
- **`temperature` 0–0.2 on every node.** These are classification and extraction tasks, not creative ones — determinism is the correct default, not an afterthought.
- **Token usage tracked per node**, feeding the `llm_usage` observability in `backend_architecture.md` §8 — real visibility into a nominally cheap system, since the paid fallback path (§2) is where an unwatched cost could actually show up.

---

## 7. Context management (state flow specifics)

Every LLM node's input/output is schema-validated (zod), matching the pattern established from the start: stateless call → structured JSON in/out → validate → retry once with a corrective prompt on failure → escalate to human on a second failure, never guess. LangGraph makes this concrete rather than hand-rolled: node I/O is typed by the state schema, and a node that returns something that doesn't match its schema fails the graph run visibly instead of silently propagating a malformed value downstream.

---

## 8. Vector DB & search

**Convex's RAG component is the vector store.** No separate Pinecone/Weaviate/etc. — embeddings and `company_rules` chunks live in the same Convex deployment as everything else, which means one fewer system to secure, scale, back up, and pay for, and one fewer network hop in the compliance-check path.

**Used exactly once, where it earns its cost:** the Vendor agent's `retrieve_rules` node, matching brochure content against `company_rules`. Not used for Expense or Hire — neither has an unstructured knowledge-base lookup need, and adding retrieval machinery where there's no retrieval problem would be exactly the kind of unnecessary AI surface area this doc exists to prevent.

---

## 9. Guardrails, restated together

Every one of these exists for the same reason — keeping a more capable model from quietly expanding its share of the decision:
- JSON-schema-validated output on every node, enforced by LangGraph's typed state
- Retry once, then escalate to a human — never guess on a second failure
- `temperature` near zero on every call
- Explicit `max_tokens` ceilings by node type
- The rules engine is a graph node, not a prompt — thresholds and policy live in code and data, never in a system prompt asking the model to "remember the budget rules"

---

## 10. Build order addendum

Set up the OpenRouter client + centralized model config before Agent 1 — this is shared infrastructure, build it once. Introduce LangGraph starting with whichever agent you build first, even Expense's simple linear graph (`extract → decide → explain`) — the complexity is genuinely small until Vendor, where the conditional gate and retrieval step are where LangGraph actually starts earning the "compulsory" label. Slots directly into `backend_architecture.md` §10 and the product doc's §8 — same four build phases, this is just the AI-specific detail inside each one.
