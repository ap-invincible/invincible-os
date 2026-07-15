# Invincible Agent OS

Convex-backed requester and approver portal. Three autonomous flows:

- Expense xlsx extraction, duplicate/category/PO checks, per-item approval.
- New-hire GitHub access proposal, human gate, idempotent GitHub execution.
- Vendor brochure policy retrieval, LLM classification, budget gate, approval.

## Start

```powershell
Copy-Item .env.example .env.local
npm.cmd install
npx.cmd convex dev
```

`convex dev` creates/selects deployment and generates `convex/_generated`. Set `VITE_CONVEX_URL` to generated deployment URL. Then run:

```powershell
npm.cmd run dev
```

## Required Convex environment

Set server-side values with `npx convex env set NAME value`:

```text
INITIAL_ADMIN_EMAIL=admin@company.com
OPENROUTER_API_KEY=...
GITHUB_PAT=...
GITHUB_ORG=invincible
NOTION_TOKEN=...                 # optional
NOTION_PARENT_PAGE_ID=...        # optional
TEAMS_WEBHOOK_URL=...            # optional
APP_URL=https://your-app.example  # optional
```

First profile matching `INITIAL_ADMIN_EMAIL` receives admin role. Other users start as requesters; admins can elevate roles through `profiles.setRole` until a dedicated people-management screen is added.

## Input contract

Expense xlsx requires `Vendor`, `Amount`, `Category`, `Date`; accepts `PO Number`, `Employee`. Missing PO is flagged for expenses at or above $500. Vendor PDF/text is stored privately; policies and budgets are admin-managed under Settings.

## Security boundaries

Public functions enforce session profile and role. Background functions are internal. Only node actions call external services. Audit rows have one write helper and no exposed mutation to alter/delete history. GitHub execution rechecks approval inside its action.
