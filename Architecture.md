# Agent OS v2 — Convex + Notion architecture (3 agents)

Supersedes the earlier custom-orchestrator design. Convex now plays the role the "orchestrator + audit log + approval queue" used to play in the previous doc — it isn't bolted on, it *is* the backend.

## 0. Core principle (unchanged, now sharper)

**The LLM translates. Code decides. The agent finishes the work before a human ever sees it.**

Every request produces a **complete draft outcome** — a flagged/cleared expense list with reasons, a proposed GitHub access grant, a vendor decision with a budget/compliance verdict — before it reaches a human. The human's job is never "process this request," it's "review, edit if needed, approve." That's what makes the requester experience close to zero-effort, per your requirement.

---

## 1. Why Convex, mapped to concrete components

| Need | Convex component | Why it fits |
|---|---|---|
| Durable multi-step agent execution that survives crashes | `Workflow` component | Steps (extract → decide → propose) run as a durable function; if the process dies mid-run it resumes, not restarts |
| External calls to LLM / GitHub / Notion, which are flaky | `Action Retrier` / `Workpool` | Automatic retry with backoff on failed HTTP calls; controlled concurrency so you don't hammer the GitHub API |
| Live requester + approver dashboards | Convex reactive queries | Both portals subscribe to the same tables; a status change (agent finishes, or approver decides) appears instantly on both screens with zero polling code |
| Storing uploaded xlsx / vendor brochures | Convex file storage | Upload once, reference by file ID everywhere downstream (extraction, compliance check, audit trail) |
| Compliance check against a rule set without stuffing it all into a 1.5B model's context | `RAG` component (vector search) | Embed the company rule set once; at request time, retrieve only the 2-3 relevant rules for the brochure's content and hand only those to the LLM |
| Scheduling the monthly expense run | `crons` | Kick off ingestion of the month's xlsx automatically, or on manual upload |
| Calling the LLM, GitHub, Notion | `actions` | The only place external HTTP calls happen; everything else (extraction result handling, rule evaluation, budget math) is a plain query/mutation |

This table is the actual answer to "use Convex wherever it improves performance or reduces effort" — each row is a specific piece of custom infrastructure the earlier design would have needed you to hand-build, that Convex gives you for free.

---

## 2. Data model (Convex tables)

```ts
// requests — one row per submission, any agent type
requests: {
  type: "expense_batch" | "hire_provisioning" | "vendor_procurement",
  requesterEmail: string,
  status: "processing" | "auto_cleared" | "pending_approval" | "approved" | "rejected" | "auto_rejected",
  createdAt: number,
}

// expense_items — parsed rows from the xlsx, linked to a request
expense_items: {
  requestId: Id<"requests">,
  vendor: string, amount: number, category: string,
  date: string, poNumber: string | null, employee: string,
  anomalyFlags: string[],           // e.g. ["missing_po", "over_category_avg"]
  status: "auto_cleared" | "flagged" | "approved" | "rejected",
  reasoning: string,                // LLM-drafted, one sentence
}

// hire_provisioning_requests
hire_provisioning_requests: {
  requestId: Id<"requests">,
  newHireEmail: string,
  githubUsername: string,
  proposedRepos: string[],          // what the agent decided to grant
  reasoning: string,
  approverEdits: string | null,     // if approver changed the repo list
  githubGrantStatus: "pending" | "granted" | "failed",
}

// vendor_requests
vendor_requests: {
  requestId: Id<"requests">,
  vendorName: string, brochureFileId: string,
  estimatedCost: number, department: string,
  complianceVerdict: "pass" | "violation" | "uncertain",
  complianceReasoning: string,
  budgetLeftover: number, budgetCovered: boolean,
  forwardedToApprover: boolean,
}

// approvals — one row per human decision, any agent type
approvals: {
  requestId: Id<"requests">,
  approverEmail: string,
  decision: "approved" | "rejected" | "edited_and_approved",
  editsMade: string | null,
  decidedAt: number,
}

// audit_log — append-only, every step from every workflow writes here
audit_log: {
  requestId: Id<"requests">,
  step: string,                     // "extract" | "decide" | "propose" | "human_verdict" | "execute"
  actor: string,                    // "expense_agent" | "hire_agent" | "vendor_agent" | "human:<email>"
  detail: string,
  timestamp: number,
}

// company_rules — chunked for RAG (vendor compliance)
company_rules: { text: string, embedding: vector, sourceDoc: string }

// notion_sync — mirrors internal records to Notion pages
notion_sync: { requestId: Id<"requests">, notionPageId: string, lastSyncedAt: number }
```

A human never needs to ask an agent "what happened" — `audit_log` filtered by `requestId`, rendered in either portal or mirrored to Notion, is the entire answer.

---

## 3. The requester/approver pattern (same shape, all three agents)

```
Requester UI ──submit──▶ Convex mutation ──▶ Workflow.start()
                                                  │
                                     [extract] → [decide] → [propose]
                                                  │
                                    writes a complete draft outcome
                                       to the relevant table
                                                  │
                              needs approval? ────┴──── no (auto-cleared/auto-rejected)
                                   │                            │
                                   ▼                            ▼
                         Approver UI shows draft         requester sees final
                         (editable fields + reasoning)   status immediately
                                   │
                    approve / edit+approve / reject
                                   │
                                   ▼
                  Convex mutation records `approvals` row,
                  triggers execute-workflow (GitHub grant, mark paid, etc.)
                                   │
                                   ▼
                    Notion report page created/updated
```

Both portals are the same Convex app reading different table slices — no separate backend per role. The requester's screen re-renders the moment the workflow finishes (usually seconds), and again the moment an approver acts, with no polling.

---

## 4. Agent 1 — Expense/invoice anomaly detection

**Requester interface:** upload `invincible_expenses_july26.xlsx` (or point to a stored file) → triggers `Workflow.start({type: "expense_batch"})`. (Can also be cron-triggered monthly.)

**Autonomous pipeline (per row, no human involved):**
1. Parse xlsx → insert one `expense_items` row per line (Convex mutation, deterministic).
2. **Decide** (deterministic query, no LLM): duplicate check (same vendor+amount within a date window), over-category-average check (`amount` vs `expense_category_baselines` mean ± N·stddev), missing-PO check (amount over threshold with no PO).
3. All pass → `status = auto_cleared`, one LLM call drafts a one-sentence reason, logged.
4. Any fail → `status = flagged`, LLM drafts why, appears on Approver UI.

**Approver interface:** table of flagged rows, every field editable (fix a miscategorized entry, add a note, mark a false positive), Approve/Reject per row. Approving = paid; rejecting = sent back with a reason.

**Notion report:** one page per run, auto-created after all rows resolve — totals, cleared count, flagged count with reasons, a table mirroring the flagged items. This is the "generate monthly reports" capability directly.

---

## 5. Agent 2 — New-hire GitHub provisioning (HR + Engineering)

**Requester interface:** two fields — new hire's **email** and **GitHub username**. Nothing else.

**Autonomous pipeline:**
1. Engineering agent looks up the default onboarding repo set (a small config table — start with one hardcoded list, no need for a full role-template system yet).
2. Drafts the proposal: `proposedRepos = [...]`, one-sentence reasoning ("standard onboarding access for new engineering hires").
3. Writes to `hire_provisioning_requests`, `status = pending_approval` (repo access is always gated in this design — no "routine, auto-provision" branch yet, since GitHub access is the sensitive item here).

**Approver interface:** shows the new hire's email, GitHub username, and proposed repo list — editable (add/remove a repo) before approving.

**On approval (autonomous execution):**
- Convex action calls the GitHub REST API — `PUT /repos/{org}/{repo}/collaborators/{githubUsername}` — once per approved repo, using a GitHub App installation token or PAT stored as a Convex environment variable/secret.
- Wrap the call in `Action Retrier` so a transient GitHub API failure doesn't silently drop the grant.
- Log each grant to `audit_log`; update `githubGrantStatus`.

**Notion report:** "New hire access — {name}" page: repos granted, timestamp, who approved.

*Extensibility note:* the earlier design's fuller role-template system (Slack, email, prod DB, sensitivity tiers) is a natural v2 — the schema (`proposedRepos` → generalize to `proposedAccess: {system, sensitivity}[]`) is intentionally shaped to grow into that without a rewrite.

---

## 6. Agent 3 — Vendor/tool procurement request

**Requester interface:** department, vendor name, brochure upload (PDF), estimated annual/monthly cost, purpose.

**Autonomous pipeline:**
1. Brochure → Convex file storage → text extracted → chunked and embedded (or embedded once if it's a known recurring vendor).
2. **Compliance check (RAG, not brute-force context stuffing):** vector search the brochure content against `company_rules`; take the top few matching rules; single narrow LLM call: "does this brochure violate this rule — yes/no/uncertain — one sentence why." This is the "greater compute/effort" case Convex's RAG component is built for — you're not asking a 1.5B model to hold your whole rulebook in its head.
3. **Budget check (pure Convex query, no LLM):** `leftover = department.monthlyBudget − sum(expense_items.amount WHERE department AND month = current)`, pulled from the same data ingested in Agent 1. `budgetCovered = estimatedCost <= leftover`.
4. **Gate:** forward to Approver UI **only if** `complianceVerdict != "violation"` **and** `budgetCovered == true`. Otherwise, auto-reject with the specific reason (budget insufficient / rule violated) — requester sees this immediately, no approver involved. *(This mirrors the budget-gating rule you specified; I've applied the same all-or-nothing gate to compliance for consistency — flag this if you'd rather compliance violations still reach a human for override.)*

**Approver interface:** vendor name, brochure link, cost, compliance verdict + reasoning, budget-remaining-after-approval — approve/reject the vendor relationship.

**Notion report:** "Vendor approved — {name}" page with cost, budget impact, compliance summary.

---

## 7. LLM hosting

Keep Qwen2.5-1.5B; move where it runs, not what it is. Host it behind a stable HTTPS endpoint (small always-on VM running Ollama/vLLM, or a serverless GPU function) and have Convex actions call that URL. This removes your laptop as a bottleneck and keeps the "seamless" property — the rest of the system only ever sees an HTTP endpoint, it doesn't care where it lives. Every prompt in this design stays short and single-purpose (per the earlier context-management rules — one call, one job, JSON-schema-validated output, retry-once-then-escalate-to-human on failure) — that discipline matters more for reliability than the raw hosting speed does.

---

## 8. Build order

1. Convex schema (§2) + both portal shells reading empty tables — prove the reactive plumbing works before any agent logic exists.
2. Agent 1 (expense) — no cross-system calls beyond the LLM, validates the whole extract→decide→propose→approve→audit→Notion loop end to end.
3. Agent 2 (hire/GitHub) — same loop, first real external-system execution (GitHub API), first use of `Action Retrier`.
4. Agent 3 (vendor) — reuses Agent 1's budget data, adds the RAG compliance check — the only genuinely new capability, everything else is composition of what you already built.
